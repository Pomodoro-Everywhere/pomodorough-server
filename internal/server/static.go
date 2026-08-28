package server

import (
	"errors"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

var hashedAssetPattern = regexp.MustCompile(`(?:^|[._-])[a-f0-9]{8,}(?:[._-]|$)`)

func (s *Server) handleOpenAPISpec(w http.ResponseWriter, r *http.Request) {
	file, info, err := s.openWebFile("openapi.yaml")
	if err != nil {
		s.logger.Error("open OpenAPI specification", "error", err)
		http.Error(w, "OpenAPI specification unavailable", http.StatusServiceUnavailable)
		return
	}
	defer file.Close()
	w.Header().Set("Content-Type", "application/yaml; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=300")
	http.ServeContent(w, r, "openapi.yaml", info.ModTime(), file)
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}
	requestPath := path.Clean("/" + r.URL.Path)
	relative, public, ok := s.resolveWebRequest(w, r, requestPath)
	if !ok {
		return
	}
	file, info, relative, ok := s.openRequestedWebFile(w, r, requestPath, relative, public)
	if !ok {
		return
	}
	defer file.Close()
	setStaticHeaders(w, relative)
	http.ServeContent(w, r, filepath.Base(relative), info.ModTime(), file)
}

func (s *Server) resolveWebRequest(w http.ResponseWriter, r *http.Request, requestPath string) (string, bool, bool) {
	relative, public := publicWebFile(requestPath)
	if public {
		return relative, true, true
	}
	if _, err := s.authenticateWeb(r); err != nil {
		returnTo := r.URL.RequestURI()
		if !strings.HasPrefix(returnTo, "/") || strings.HasPrefix(returnTo, "//") {
			returnTo = "/app"
		}
		http.Redirect(w, r, "/auth/google/start?return="+url.QueryEscape(returnTo), http.StatusFound)
		return "", false, false
	}
	if requestPath == "/app" {
		return "app.html", false, true
	}
	return strings.TrimPrefix(requestPath, "/"), false, true
}

func (s *Server) openRequestedWebFile(w http.ResponseWriter, r *http.Request, requestPath, relative string, public bool) (*os.File, os.FileInfo, string, bool) {
	file, info, err := s.openWebFile(relative)
	entrypoint := relative == "index.html" || relative == "app.html"
	if err != nil && !public && strings.HasPrefix(requestPath, "/app/") && path.Ext(relative) == "" {
		file, info, err = s.openWebFile("app.html")
		if err == nil {
			return file, info, "app.html", true
		}
		s.logger.Error("open SPA entrypoint", "error", err)
		http.Error(w, "Application unavailable", http.StatusServiceUnavailable)
		return nil, nil, "", false
	}
	if err == nil {
		return file, info, relative, true
	}
	if entrypoint {
		s.logger.Error("open web entrypoint", "path", relative, "error", err)
		http.Error(w, "Application unavailable", http.StatusServiceUnavailable)
	} else {
		http.NotFound(w, r)
	}
	return nil, nil, "", false
}

func setStaticHeaders(w http.ResponseWriter, relative string) {
	extension := strings.ToLower(filepath.Ext(relative))
	contentType := mime.TypeByExtension(extension)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	base := filepath.Base(relative)
	switch {
	case relative == "index.html" || relative == "app.html" || relative == "privacy.html":
		w.Header().Set("Cache-Control", "no-store")
	case base == "sw.js" || base == "manifest.webmanifest":
		w.Header().Set("Cache-Control", "no-cache")
	case hashedAssetPattern.MatchString(base):
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	default:
		w.Header().Set("Cache-Control", "public, max-age=300")
	}
}

func publicWebFile(requestPath string) (string, bool) {
	switch requestPath {
	case "/", "/index.html":
		return "index.html", true
	case "/landing.css":
		return "landing.css", true
	case "/platform-selector.js":
		return "platform-selector.js", true
	case "/landing.js":
		return "landing.js", true
	case "/icon.svg":
		return "icon.svg", true
	case "/privacy", "/privacy.html":
		return "privacy.html", true
	default:
		return "", false
	}
}

func (s *Server) authenticateWeb(r *http.Request) (principal, error) {
	if r.Header.Get("Authorization") != "" {
		return principal{}, errors.New("web session required")
	}
	return s.authenticate(r)
}

func (s *Server) openWebFile(relative string) (*os.File, os.FileInfo, error) {
	root := filepath.Clean(s.cfg.WebRoot)
	candidate := filepath.Join(root, filepath.FromSlash(relative))
	if candidate != root && !strings.HasPrefix(candidate, root+string(filepath.Separator)) {
		return nil, nil, os.ErrNotExist
	}
	file, err := os.Open(candidate)
	if err != nil {
		return nil, nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		if err == nil {
			err = errors.New("web path is not a regular file")
		}
		return nil, nil, err
	}
	return file, info, nil
}
