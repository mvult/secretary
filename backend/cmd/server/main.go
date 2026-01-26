package main

import (
  "log"
  "net/http"
  "os"
)

func main() {
  addr := ":8080"
  if v := os.Getenv("ADDR"); v != "" {
    addr = v
  }

  mux := http.NewServeMux()
  mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
    w.WriteHeader(http.StatusOK)
    _, _ = w.Write([]byte("ok"))
  })

  log.Printf("listening on %s", addr)
  log.Fatal(http.ListenAndServe(addr, mux))
}
