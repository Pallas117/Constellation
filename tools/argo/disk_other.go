//go:build !unix

package main

// diskFreeGB reports 0 (unknown) where there is no statfs; Gauss then treats
// the device as unable to host until a platform reading is added.
func diskFreeGB(string) float64 { return 0 }
