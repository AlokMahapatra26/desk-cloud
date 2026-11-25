package deskcloud

import (
	"fmt"
	"net/http"
	"os/exec"
	"runtime"
	"time"
)

type PowerRunner func(action string) (map[string]any, error)

func GetPowerCommand(action, platform string) (string, []string, error) {
	if platform == "" {
		platform = runtime.GOOS
	}
	switch platform {
	case "windows":
		switch action {
		case "shutdown":
			return "shutdown", []string{"/s", "/t", "3"}, nil
		case "restart":
			return "shutdown", []string{"/r", "/t", "3"}, nil
		case "sleep":
			return "rundll32.exe", []string{"powrprof.dll,SetSuspendState", "0,1,0"}, nil
		}
	case "darwin":
		switch action {
		case "shutdown":
			return "osascript", []string{"-e", `tell app "System Events" to shut down`}, nil
		case "restart":
			return "osascript", []string{"-e", `tell app "System Events" to restart`}, nil
		case "sleep":
			return "pmset", []string{"sleepnow"}, nil
		}
	default:
		switch action {
		case "shutdown":
			return "systemctl", []string{"poweroff"}, nil
		case "restart":
			return "systemctl", []string{"reboot"}, nil
		case "sleep":
			return "systemctl", []string{"suspend"}, nil
		}
	}
	return "", nil, &httpError{Status: http.StatusBadRequest, Msg: "Invalid power action. Must be shutdown, restart, or sleep."}
}

func ExecutePowerAction(action string) (map[string]any, error) {
	cmd, args, err := GetPowerCommand(action, runtime.GOOS)
	if err != nil {
		return nil, err
	}
	time.AfterFunc(350*time.Millisecond, func() {
		if runErr := exec.Command(cmd, args...).Run(); runErr != nil {
			fmt.Printf("Power action %q failed: %v\n", action, runErr)
		}
	})
	return map[string]any{"ok": true, "action": action}, nil
}

