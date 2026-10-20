//go:build unix

package main

import "syscall"

// diskFreeGB is the space available to unprivileged users on path's filesystem.
func diskFreeGB(path string) float64 {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0
	}
	return gb(float64(st.Bavail) * float64(st.Bsize))
}
