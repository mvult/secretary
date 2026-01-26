package db

import (
  "context"
  "fmt"

  "github.com/jackc/pgx/v5/pgxpool"
)

func Open(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
  if dsn == "" {
    return nil, fmt.Errorf("DATABASE_URL is required")
  }
  config, err := pgxpool.ParseConfig(dsn)
  if err != nil {
    return nil, err
  }
  return pgxpool.NewWithConfig(ctx, config)
}
