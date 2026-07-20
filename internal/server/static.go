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
	identity, err := s.authenticateWeb(r)
	if err != nil {
		returnTo := r.URL.RequestURI()
		if !strings.HasPrefix(returnTo, "/") || strings.HasPrefix(returnTo, "//") {
			returnTo = "/"
		}
		http.Redirect(w, r, "/auth/google/start?return="+url.QueryEscape(returnTo), http.StatusFound)
		return
	}
	_ = identity
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	requestPath := path.Clean("/" + r.URL.Path)
	relative := strings.TrimPrefix(requestPath, "/")
	if relative == "" || strings.HasSuffix(r.URL.Path, "/") {
		relative = "index.html"
	}
	file, info, err := s.openWebFile(relative)
	if err != nil {
		acceptsHTML := strings.Contains(r.Header.Get("Accept"), "text/html") || path.Ext(relative) == ""
		if !acceptsHTML {
			http.NotFound(w, r)
			return
		}
		file, info, err = s.openWebFile("index.html")
		if err != nil {
			s.logger.Error("open SPA entrypoint", "error", err)
			http.Error(w, "Application unavailable", http.StatusServiceUnavailable)
			return
		}
		relative = "index.html"
	}
	defer file.Close()

	extension := strings.ToLower(filepath.Ext(relative))
	contentType := mime.TypeByExtension(extension)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	base := filepath.Base(relative)
	switch {
	case relative == "index.html":
		w.Header().Set("Cache-Control", "no-store")
	case base == "sw.js" || base == "manifest.webmanifest":
		w.Header().Set("Cache-Control", "no-cache")
	case hashedAssetPattern.MatchString(base):
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	default:
		w.Header().Set("Cache-Control", "public, max-age=300")
	}
	http.ServeContent(w, r, base, info.ModTime(), file)
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
