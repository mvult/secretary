package whatsapp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"runtime/debug"
	"time"
)

type LibraryUpdate struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	Available bool   `json:"available"`
}

func (s *Service) watchLibraryUpdates(ctx context.Context) {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return
	}
	current := ""
	for _, dep := range info.Deps {
		if dep.Path == "go.mau.fi/whatsmeow" && dep.Replace == nil {
			current = dep.Version
		}
	}
	if current == "" {
		return
	}
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for {
		checkCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		update, err := checkLibraryUpdate(checkCtx, http.DefaultClient, "https://proxy.golang.org/go.mau.fi/whatsmeow", current)
		cancel()
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("whatsapp update check failed: %v", err)
		} else {
			s.mu.Lock()
			s.status.LibraryUpdate = &update
			s.mu.Unlock()
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func checkLibraryUpdate(ctx context.Context, client *http.Client, proxy, current string) (LibraryUpdate, error) {
	type versionInfo struct {
		Version string
		Time    time.Time
	}
	fetch := func(path string) (versionInfo, error) {
		var info versionInfo
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, proxy+path, nil)
		if err != nil {
			return info, err
		}
		resp, err := client.Do(req)
		if err != nil {
			return info, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return info, fmt.Errorf("module proxy returned %d", resp.StatusCode)
		}
		err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&info)
		if err == nil && (info.Version == "" || info.Time.IsZero()) {
			err = fmt.Errorf("module proxy returned incomplete version metadata")
		}
		return info, err
	}
	latest, err := fetch("/@latest")
	update := LibraryUpdate{Current: current, Latest: latest.Version}
	if err != nil || latest.Version == current {
		return update, err
	}
	installed, err := fetch("/@v/" + url.PathEscape(current) + ".info")
	if err != nil {
		return update, err
	}
	if installed.Version != current {
		return update, fmt.Errorf("module proxy returned mismatched installed version")
	}
	// WhatsMeow uses pseudo-versions. Compare commit times, not string ordering;
	// an older proxy response must not advertise a downgrade as an update.
	update.Available = latest.Time.After(installed.Time)
	return update, nil
}
