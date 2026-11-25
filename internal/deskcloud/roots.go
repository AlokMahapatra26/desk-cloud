package deskcloud

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

type RootInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path,omitempty"`
}

type SysDirEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type SysBrowseResponse struct {
	CurrentPath string        `json:"currentPath"`
	ParentPath  *string       `json:"parentPath"`
	Directories []SysDirEntry `json:"directories"`
}

func isReadableDir(dirPath string) bool {
	st, err := os.Stat(dirPath)
	return err == nil && st.IsDir()
}

func getSystemQuickLocations() []SysDirEntry {
	var locations []SysDirEntry
	seen := make(map[string]bool)

	addIfExists := func(label, targetPath string) {
		abs, err := filepath.Abs(targetPath)
		if err != nil || seen[abs] {
			return
		}
		if isReadableDir(abs) {
			seen[abs] = true
			locations = append(locations, SysDirEntry{Name: label, Path: abs})
		}
	}

	home, _ := os.UserHomeDir()
	if home != "" {
		base := filepath.Base(home)
		if base == "" {
			base = home
		}
		addIfExists(fmt.Sprintf("Home (%s)", base), home)
		for _, folder := range []string{"Desktop", "Documents", "Downloads", "Movies", "Videos", "Music", "Pictures"} {
			addIfExists(folder, filepath.Join(home, folder))
		}
	}

	if runtime.GOOS == "windows" {
		for code := 'A'; code <= 'Z'; code++ {
			drive := fmt.Sprintf("%c:\\", code)
			addIfExists(fmt.Sprintf("Drive (%s)", drive), drive)
		}
	} else {
		addIfExists("Filesystem Root (/)", "/")
		var mountParents []string
		if runtime.GOOS == "darwin" {
			mountParents = []string{"/Volumes"}
		} else {
			mountParents = []string{"/mnt", "/media"}
			if u, err := user.Current(); err == nil && u.Username != "" {
				mountParents = append(mountParents, filepath.Join("/media", u.Username))
			}
		}
		for _, parent := range mountParents {
			if !isReadableDir(parent) {
				continue
			}
			entries, err := os.ReadDir(parent)
			if err != nil {
				continue
			}
			for _, e := range entries {
				if e.IsDir() {
					addIfExists("Drive: "+e.Name(), filepath.Join(parent, e.Name()))
				}
			}
		}
	}

	if locations == nil {
		locations = []SysDirEntry{}
	}
	return locations
}

func BrowseSystemDirs(dirPath string) (*SysBrowseResponse, error) {
	if dirPath == "" {
		return &SysBrowseResponse{
			CurrentPath: "",
			ParentPath:  nil,
			Directories: getSystemQuickLocations(),
		}, nil
	}

	abs, err := filepath.Abs(dirPath)
	if err != nil {
		return nil, &httpError{Status: http.StatusNotFound, Msg: "Directory not accessible"}
	}
	realPath, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, &httpError{Status: http.StatusNotFound, Msg: fmt.Sprintf("Directory not accessible: %s", abs)}
	}
	st, err := os.Stat(realPath)
	if err != nil || !st.IsDir() {
		return nil, &httpError{Status: http.StatusBadRequest, Msg: "Selected path is not a directory"}
	}

	entries, err := os.ReadDir(realPath)
	if err != nil {
		return nil, err
	}
	dirs := make([]SysDirEntry, 0)
	for _, d := range entries {
		if d.IsDir() {
			dirs = append(dirs, SysDirEntry{
				Name: d.Name(),
				Path: filepath.Join(realPath, d.Name()),
			})
		}
	}
	sort.Slice(dirs, func(i, j int) bool {
		return naturalLess(dirs[i].Name, dirs[j].Name)
	})

	vol := filepath.VolumeName(realPath)
	isRoot := realPath == vol+string(filepath.Separator) || realPath == "/"
	parent := ""
	if !isRoot {
		parent = filepath.Dir(realPath)
	}

	return &SysBrowseResponse{
		CurrentPath: realPath,
		ParentPath:  &parent,
		Directories: dirs,
	}, nil
}

func PersistRoots(cfg *Config) error {
	if cfg.RootsFile == "" {
		return nil
	}
	data := make([]rootInput, 0, len(cfg.Roots))
	for _, r := range cfg.Roots {
		name := r.BaseName
		if name == "" {
			name = r.Name
		}
		data = append(data, rootInput{Name: name, Path: r.Path})
	}
	raw, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(cfg.RootsFile), 0o755); err != nil {
		return err
	}
	return os.WriteFile(cfg.RootsFile, raw, 0o644)
}

func SerializeRoots(roots []Root) []RootInfo {
	out := make([]RootInfo, 0, len(roots))
	for _, r := range roots {
		out = append(out, RootInfo{ID: r.ID, Name: r.Name, Path: r.Path})
	}
	return out
}

func AddRoot(cfg *Config, targetPath, customName string) (*Root, []RootInfo, error) {
	trimmed := strings.TrimSpace(targetPath)
	if trimmed == "" {
		return nil, nil, &httpError{Status: http.StatusBadRequest, Msg: "Missing directory path"}
	}
	abs, err := filepath.Abs(trimmed)
	if err != nil {
		return nil, nil, &httpError{Status: http.StatusNotFound, Msg: fmt.Sprintf("Directory does not exist: %s", trimmed)}
	}
	realPath, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, nil, &httpError{Status: http.StatusNotFound, Msg: fmt.Sprintf("Directory does not exist: %s", abs)}
	}
	st, err := os.Stat(realPath)
	if err != nil || !st.IsDir() {
		return nil, nil, &httpError{Status: http.StatusBadRequest, Msg: "Path is not a directory"}
	}

	for i := range cfg.Roots {
		if cfg.Roots[i].Path == realPath {
			return &cfg.Roots[i], SerializeRoots(cfg.Roots), nil
		}
	}

	maxID := -1
	for _, r := range cfg.Roots {
		if idNum, err := strconv.Atoi(r.ID); err == nil && idNum > maxID {
			maxID = idNum
		}
	}
	nextID := strconv.Itoa(maxID + 1)
	baseName := strings.TrimSpace(customName)
	if baseName == "" {
		baseName = filepath.Base(realPath)
		if baseName == "" || baseName == "." {
			baseName = realPath
		}
	}

	cfg.Roots = append(cfg.Roots, Root{
		ID:       nextID,
		Name:     baseName,
		BaseName: baseName,
		Path:     realPath,
	})
	disambiguateRootNames(cfg.Roots)
	if err := PersistRoots(cfg); err != nil {
		return nil, nil, err
	}
	added := cfg.Roots[len(cfg.Roots)-1]
	return &added, SerializeRoots(cfg.Roots), nil
}

func RemoveRoot(cfg *Config, rootID string) ([]RootInfo, error) {
	idx := -1
	for i, r := range cfg.Roots {
		if r.ID == rootID {
			idx = i
			break
		}
	}
	if idx == -1 {
		return nil, &httpError{Status: http.StatusNotFound, Msg: "Shared folder not found"}
	}
	cfg.Roots = append(cfg.Roots[:idx], cfg.Roots[idx+1:]...)
	disambiguateRootNames(cfg.Roots)
	if err := PersistRoots(cfg); err != nil {
		return nil, err
	}
	return SerializeRoots(cfg.Roots), nil
}

