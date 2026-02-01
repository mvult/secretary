package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	"github.com/mvult/secretary/backend/internal/db"
	"github.com/mvult/secretary/backend/internal/server"
)

func main() {
	if err := godotenv.Load(); err != nil {
		// It's not an error if .env doesn't exist, we might be in production using real env vars.
		// But let's log it just in case.
		log.Println("No .env file found, using system environment variables")
	}

	addr := ":8080"
	if v := os.Getenv("ADDR"); v != "" {
		addr = v
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.Open(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()

	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" {
		log.Fatal("JWT_SECRET is required")
	}
	ttlHours := 168
	if v := os.Getenv("JWT_TTL_HOURS"); v != "" {
		parsed, err := strconv.Atoi(v)
		if err != nil || parsed <= 0 {
			log.Fatal("JWT_TTL_HOURS must be a positive integer")
		}
		ttlHours = parsed
	}

	srv := server.New(pool, []byte(jwtSecret), time.Duration(ttlHours)*time.Hour)
	httpServer := &http.Server{
		Addr:              addr,
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("listening on %s", addr)
	go func() {
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
}
