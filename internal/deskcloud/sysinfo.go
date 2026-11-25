package deskcloud

import (
	"encoding/json"
	"math"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
)

type CpuInfo struct {
	Cores    int       `json:"cores"`
	Model    string    `json:"model"`
	LoadAvg  []float64 `json:"loadAvg"`
	UsagePct float64   `json:"usagePct"`
}

type MemoryInfo struct {
	TotalBytes uint64  `json:"totalBytes"`
	UsedBytes  uint64  `json:"usedBytes"`
	FreeBytes  uint64  `json:"freeBytes"`
	UsedPct    float64 `json:"usedPct"`
}

type DiskInfo struct {
	Mount      string  `json:"mount"`
	TotalBytes uint64  `json:"totalBytes"`
	UsedBytes  uint64  `json:"usedBytes"`
	FreeBytes  uint64  `json:"freeBytes"`
	UsedPct    float64 `json:"usedPct"`
}

type ProcessInfo struct {
	PID      int     `json:"pid"`
	Name     string  `json:"name"`
	CpuPct   float64 `json:"cpuPct"`
	MemPct   float64 `json:"memPct"`
	MemBytes uint64  `json:"memBytes"`
}

type SystemStats struct {
	Hostname  string        `json:"hostname"`
	Platform  string        `json:"platform"`
	Arch      string        `json:"arch"`
	UptimeSec int64         `json:"uptimeSec"`
	CPU       CpuInfo       `json:"cpu"`
	Memory    MemoryInfo    `json:"memory"`
	Disks     []DiskInfo    `json:"disks"`
	Processes []ProcessInfo `json:"processes"`
}

var (
	cpuMu      sync.Mutex
	prevIdle   uint64
	prevTotal  uint64
	hasPrevCPU bool
	lastCPUPct float64
)

func round1(v float64) float64 {
	return math.Round(v*10) / 10
}

func sampleLinuxCPU() float64 {
	raw, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0
	}
	lines := strings.SplitN(string(raw), "\n", 2)
	if len(lines) == 0 {
		return 0
	}
	fields := strings.Fields(lines[0])
	if len(fields) < 5 || fields[0] != "cpu" {
		return 0
	}
	var total, idle uint64
	for i := 1; i < len(fields); i++ {
		val, _ := strconv.ParseUint(fields[i], 10, 64)
		total += val
		if i == 4 || i == 5 {
			idle += val
		}
	}

	cpuMu.Lock()
	defer cpuMu.Unlock()
	if hasPrevCPU && total > prevTotal {
		dt := float64(total - prevTotal)
		di := float64(idle - prevIdle)
		lastCPUPct = round1(((dt - di) / dt) * 100)
	}
	prevIdle = idle
	prevTotal = total
	hasPrevCPU = true
	return lastCPUPct
}

func readLinuxLoadAndUptime() ([]float64, int64) {
	loadAvg := []float64{0, 0, 0}
	if raw, err := os.ReadFile("/proc/loadavg"); err == nil {
		fields := strings.Fields(string(raw))
		if len(fields) >= 3 {
			for i := 0; i < 3; i++ {
				if v, err := strconv.ParseFloat(fields[i], 64); err == nil {
					loadAvg[i] = math.Round(v*100) / 100
				}
			}
		}
	}
	var uptime int64
	if raw, err := os.ReadFile("/proc/uptime"); err == nil {
		fields := strings.Fields(string(raw))
		if len(fields) >= 1 {
			if v, err := strconv.ParseFloat(fields[0], 64); err == nil {
				uptime = int64(v)
			}
		}
	}
	return loadAvg, uptime
}

func readMemoryInfo() MemoryInfo {
	if runtime.GOOS == "linux" {
		raw, err := os.ReadFile("/proc/meminfo")
		if err == nil {
			var totalKB, availKB uint64
			for _, line := range strings.Split(string(raw), "\n") {
				if strings.HasPrefix(line, "MemTotal:") {
					fields := strings.Fields(line)
					if len(fields) >= 2 {
						totalKB, _ = strconv.ParseUint(fields[1], 10, 64)
					}
				} else if strings.HasPrefix(line, "MemAvailable:") {
					fields := strings.Fields(line)
					if len(fields) >= 2 {
						availKB, _ = strconv.ParseUint(fields[1], 10, 64)
					}
				}
			}
			if totalKB > 0 {
				total := totalKB * 1024
				free := availKB * 1024
				used := uint64(0)
				if total > free {
					used = total - free
				}
				return MemoryInfo{
					TotalBytes: total,
					UsedBytes:  used,
					FreeBytes:  free,
					UsedPct:    round1(float64(used) / float64(total) * 100),
				}
			}
		}
	}
	return MemoryInfo{}
}

func readDisks() []DiskInfo {
	if runtime.GOOS == "windows" {
		out, err := exec.Command("powershell", "-NoProfile", "-Command",
			"Get-PSDrive -PSProvider FileSystem | Where-Object {$_.Used -ne $null -or $_.Free -ne $null} | Select-Object Root,Used,Free | ConvertTo-Json").Output()
		if err != nil {
			return []DiskInfo{}
		}
		var arr []struct {
			Root string `json:"Root"`
			Used uint64 `json:"Used"`
			Free uint64 `json:"Free"`
		}
		if err := json.Unmarshal(out, &arr); err != nil {
			return []DiskInfo{}
		}
		disks := make([]DiskInfo, 0, len(arr))
		for _, d := range arr {
			tot := d.Used + d.Free
			pct := 0.0
			if tot > 0 {
				pct = round1(float64(d.Used) / float64(tot) * 100)
			}
			disks = append(disks, DiskInfo{Mount: d.Root, TotalBytes: tot, UsedBytes: d.Used, FreeBytes: d.Free, UsedPct: pct})
		}
		return disks
	}

	out, err := exec.Command("df", "-kP").Output()
	if err != nil {
		return []DiskInfo{}
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) <= 1 {
		return []DiskInfo{}
	}
	seen := make(map[string]bool)
	disks := make([]DiskInfo, 0)
	for _, line := range lines[1:] {
		fields := strings.Fields(line)
		if len(fields) < 6 {
			continue
		}
		fsName := fields[0]
		totalKb, _ := strconv.ParseUint(fields[1], 10, 64)
		usedKb, _ := strconv.ParseUint(fields[2], 10, 64)
		availKb, _ := strconv.ParseUint(fields[3], 10, 64)
		mount := strings.Join(fields[5:], " ")
		if totalKb == 0 || fsName == "tmpfs" || fsName == "devtmpfs" || fsName == "udev" || strings.HasPrefix(mount, "/snap") {
			continue
		}
		if seen[mount] {
			continue
		}
		seen[mount] = true
		tot := totalKb * 1024
		used := usedKb * 1024
		disks = append(disks, DiskInfo{
			Mount:      mount,
			TotalBytes: tot,
			UsedBytes:  used,
			FreeBytes:  availKb * 1024,
			UsedPct:    round1(float64(used) / float64(tot) * 100),
		})
	}
	return disks
}

func readTopProcesses(limit int) []ProcessInfo {
	if runtime.GOOS == "windows" {
		return []ProcessInfo{}
	}
	args := []string{"-eo", "pid,comm,%cpu,%mem,rss", "--sort=-%cpu"}
	if runtime.GOOS == "darwin" {
		args = []string{"-eo", "pid,comm,%cpu,%mem,rss", "-r"}
	}
	out, err := exec.Command("ps", args...).Output()
	if err != nil {
		return []ProcessInfo{}
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	procs := make([]ProcessInfo, 0, limit)
	for i := 1; i < len(lines) && len(procs) < limit; i++ {
		fields := strings.Fields(lines[i])
		if len(fields) < 5 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		rssKb, _ := strconv.ParseUint(fields[len(fields)-1], 10, 64)
		memPct, _ := strconv.ParseFloat(fields[len(fields)-2], 64)
		cpuPct, _ := strconv.ParseFloat(fields[len(fields)-3], 64)
		name := strings.Join(fields[1:len(fields)-3], " ")
		procs = append(procs, ProcessInfo{
			PID:      pid,
			Name:     name,
			CpuPct:   cpuPct,
			MemPct:   memPct,
			MemBytes: rssKb * 1024,
		})
	}
	return procs
}

func GetSystemStats() *SystemStats {
	host, _ := os.Hostname()
	loadAvg, uptime := readLinuxLoadAndUptime()
	return &SystemStats{
		Hostname:  host,
		Platform:  runtime.GOOS,
		Arch:      runtime.GOARCH,
		UptimeSec: uptime,
		CPU: CpuInfo{
			Cores:    runtime.NumCPU(),
			Model:    "CPU",
			LoadAvg:  loadAvg,
			UsagePct: sampleLinuxCPU(),
		},
		Memory:    readMemoryInfo(),
		Disks:     readDisks(),
		Processes: readTopProcesses(15),
	}
}

