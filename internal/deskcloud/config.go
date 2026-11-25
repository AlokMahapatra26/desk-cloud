package deskcloud

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const HelpText = `
DeskCloud — Turn any computer into a private file & media cloud

Usage:
  deskcloud [options]   (or: go run . [options])

Options:
  -d, --dir <path>        Directory to share (repeatable for multiple drives/folders)
                          If omitted, loads saved UI folders or starts ready to add in UI
  -p, --port <number>     Port to listen on (default: 8080, or PORT env)
      --host <address>    Host/interface to bind (default: 0.0.0.0, or HOST env)
  -P, --password <pass>   Access password (or STORAGE_PASSWORD env)
                          If omitted, a random password is generated on startup
      --no-auth           Disable password authentication (for trusted LAN only)
  -r, --readonly          Disable uploads, folder creation, renaming, deletion, and root changes
  -t, --tunnel            Automatically expose via Cloudflare Tunnel (downloads cloudflared if needed)
      --allow-power       Allow authenticated remote Shutdown, Restart, and Sleep from the UI
      --roots-file <path> Path to JSON file storing UI-added folders
  -h, --help              Show this help message

Examples:
  deskcloud
  deskcloud --tunnel
  deskcloud --dir "D:\Movies" --password "my-secret"
  deskcloud -d ~/Movies -d ~/Documents -p 9000
`

type Root struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	BaseName string `json:"-"`
	Path     string `json:"path"`
}

type Config struct {
	Help              bool
	Port              int
	Host              string
	Roots             []Root
	RootsFile         string
	CliPinnedRoots    bool
	AuthEnabled       bool
	Password          string
	GeneratedPassword bool
	Readonly          bool
	Tunnel            bool
	AllowPower        bool
	SessionSecret     []byte
	ChunkSizeBytes    int64
}

func envLookup(env map[string]string, key string) string {
	if env != nil {
		return env[key]
	}
	return os.Getenv(key)
}

func ParseConfig(argv []string, env map[string]string) (*Config, error) {
	var dirs []string
	port := 8080
	if pStr := envLookup(env, "PORT"); pStr != "" {
		p, err := strconv.Atoi(pStr)
		if err != nil {
			return nil, fmt.Errorf("invalid port: %s", pStr)
		}
		port = p
	}

	host := envLookup(env, "HOST")
	if host == "" {
		host = "0.0.0.0"
	}
	password := envLookup(env, "STORAGE_PASSWORD")
	noAuth := false
	readonly := envLookup(env, "STORAGE_READONLY") == "1" || envLookup(env, "STORAGE_READONLY") == "true"
	tunnel := envLookup(env, "STORAGE_TUNNEL") == "1" || envLookup(env, "STORAGE_TUNNEL") == "true"
	allowPower := envLookup(env, "STORAGE_ALLOW_POWER") == "1" || envLookup(env, "STORAGE_ALLOW_POWER") == "true"

	home, _ := os.UserHomeDir()
	rootsFile := envLookup(env, "STORAGE_ROOTS_FILE")
	if rootsFile == "" {
		rootsFile = filepath.Join(home, ".storage-server-roots.json")
	}

	if rawDirs := envLookup(env, "STORAGE_DIRS"); rawDirs != "" {
		for _, entry := range strings.Split(rawDirs, string(os.PathListSeparator)) {
			if trimmed := strings.TrimSpace(entry); trimmed != "" {
				dirs = append(dirs, trimmed)
			}
		}
	}

	help := false
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		nextVal := func() (string, error) {
			if i+1 >= len(argv) {
				return "", fmt.Errorf("missing value for %s", arg)
			}
			i++
			return argv[i], nil
		}

		switch {
		case arg == "-h" || arg == "--help":
			help = true
		case arg == "-r" || arg == "--readonly":
			readonly = true
		case arg == "-t" || arg == "--tunnel":
			tunnel = true
		case arg == "--allow-power":
			allowPower = true
		case arg == "--no-auth":
			noAuth = true
		case arg == "-d" || arg == "--dir":
			val, err := nextVal()
			if err != nil {
				return nil, err
			}
			dirs = append(dirs, val)
		case strings.HasPrefix(arg, "--dir="):
			dirs = append(dirs, strings.TrimPrefix(arg, "--dir="))
		case arg == "-p" || arg == "--port":
			val, err := nextVal()
			if err != nil {
				return nil, err
			}
			p, err := strconv.Atoi(val)
			if err != nil {
				return nil, fmt.Errorf("invalid port: %s", val)
			}
			port = p
		case strings.HasPrefix(arg, "--port="):
			val := strings.TrimPrefix(arg, "--port=")
			p, err := strconv.Atoi(val)
			if err != nil {
				return nil, fmt.Errorf("invalid port: %s", val)
			}
			port = p
		case arg == "--host":
			val, err := nextVal()
			if err != nil {
				return nil, err
			}
			host = val
		case strings.HasPrefix(arg, "--host="):
			host = strings.TrimPrefix(arg, "--host=")
		case arg == "-P" || arg == "--password":
			val, err := nextVal()
			if err != nil {
				return nil, err
			}
			password = val
		case strings.HasPrefix(arg, "--password="):
			password = strings.TrimPrefix(arg, "--password=")
		case arg == "--roots-file":
			val, err := nextVal()
			if err != nil {
				return nil, err
			}
			abs, err := filepath.Abs(val)
			if err != nil {
				return nil, err
			}
			rootsFile = abs
		case strings.HasPrefix(arg, "--roots-file="):
			abs, err := filepath.Abs(strings.TrimPrefix(arg, "--roots-file="))
			if err != nil {
				return nil, err
			}
			rootsFile = abs
		default:
			return nil, fmt.Errorf("unknown argument: %s", arg)
		}
	}

	if port < 0 || port > 65535 {
		return nil, fmt.Errorf("invalid port: %d", port)
	}

	var roots []Root
	var err error
	if len(dirs) > 0 {
		raw := make([]rootInput, 0, len(dirs))
		for _, d := range dirs {
			raw = append(raw, rootInput{Path: d})
		}
		roots, err = normalizeRootEntries(raw)
		if err != nil {
			return nil, err
		}
	} else {
		roots = loadSavedRoots(rootsFile)
	}

	generatedPassword := false
	if !noAuth && password == "" {
		b := make([]byte, 9)
		if _, err := rand.Read(b); err != nil {
			return nil, err
		}
		password = base64.RawURLEncoding.EncodeToString(b)
		generatedPassword = true
	}

	var secret []byte
	if envSecret := envLookup(env, "STORAGE_SECRET"); envSecret != "" {
		h := sha256.Sum256([]byte(envSecret))
		secret = h[:]
	} else {
		secret = make([]byte, 32)
		if _, err := rand.Read(secret); err != nil {
			return nil, err
		}
	}

	return &Config{
		Help:              help,
		Port:              port,
		Host:              host,
		Roots:             roots,
		RootsFile:         rootsFile,
		CliPinnedRoots:    len(dirs) > 0,
		AuthEnabled:       !noAuth,
		Password:          password,
		GeneratedPassword: generatedPassword,
		Readonly:          readonly,
		Tunnel:            tunnel,
		AllowPower:        allowPower,
		SessionSecret:     secret,
		ChunkSizeBytes:    20 * 1024 * 1024,
	}, nil
}

type rootInput struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

func normalizeRootEntries(raw []rootInput) ([]Root, error) {
	roots := make([]Root, 0, len(raw))
	seen := make(map[string]bool)

	for _, entry := range raw {
		if entry.Path == "" {
			continue
		}
		abs, err := filepath.Abs(entry.Path)
		if err != nil {
			return nil, err
		}
		info, err := os.Stat(abs)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil, fmt.Errorf("directory does not exist: %s", abs)
			}
			return nil, err
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("path is not a directory: %s", abs)
		}
		realPath, err := filepath.EvalSymlinks(abs)
		if err != nil {
			return nil, err
		}
		if seen[realPath] {
			continue
		}
		seen[realPath] = true

		base := entry.Name
		if base == "" {
			base = filepath.Base(realPath)
			if base == "" || base == "." {
				base = realPath
			}
		}
		roots = append(roots, Root{
			ID:       strconv.Itoa(len(roots)),
			Name:     base,
			BaseName: base,
			Path:     realPath,
		})
	}

	disambiguateRootNames(roots)
	return roots, nil
}

func disambiguateRootNames(roots []Root) {
	counts := make(map[string]int)
	for i := range roots {
		base := roots[i].BaseName
		if base == "" {
			base = roots[i].Name
			roots[i].BaseName = base
		}
		counts[base]++
	}
	for i := range roots {
		if counts[roots[i].BaseName] > 1 {
			roots[i].Name = fmt.Sprintf("%s (%s)", roots[i].BaseName, roots[i].Path)
		} else {
			roots[i].Name = roots[i].BaseName
		}
	}
}

func loadSavedRoots(rootsFile string) []Root {
	if rootsFile == "" {
		return nil
	}
	data, err := os.ReadFile(rootsFile)
	if err != nil {
		return nil
	}
	var raw []rootInput
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil
	}
	var valid []rootInput
	for _, item := range raw {
		if item.Path == "" {
			continue
		}
		if info, err := os.Stat(item.Path); err == nil && info.IsDir() {
			valid = append(valid, item)
		}
	}
	roots, err := normalizeRootEntries(valid)
	if err != nil {
		return nil
	}
	return roots
}

