# syntax=docker/dockerfile:1

# -----------------------------------------------------------------------------
# Stage 1: Base Generator (Tools)
# -----------------------------------------------------------------------------
FROM golang:1.25-alpine AS generator
WORKDIR /workspace

# Install Go tools
RUN go install github.com/bufbuild/buf/cmd/buf@v1.47.2 && \
    go install github.com/sqlc-dev/sqlc/cmd/sqlc@v1.27.0 && \
    go install google.golang.org/protobuf/cmd/protoc-gen-go@latest && \
    go install connectrpc.com/connect/cmd/protoc-gen-connect-go@latest

# Install Node.js and plugins for frontend generation
# We use npm here because it's native to Alpine and stable for installing the generator plugins
RUN apk add --no-cache nodejs npm && \
    npm install -g @bufbuild/protoc-gen-es @connectrpc/protoc-gen-connect-es

# Copy necessary files for generation
COPY buf.gen.frontend.yaml .
COPY backend/buf.gen.yaml backend/buf.gen.yaml
COPY backend/sqlc.yaml backend/sqlc.yaml
COPY backend/proto backend/proto
COPY backend/sql backend/sql

# Generate Backend Code
WORKDIR /workspace/backend
RUN buf generate proto
RUN sqlc generate

# Generate Frontend Code
WORKDIR /workspace
RUN buf generate backend/proto --template buf.gen.frontend.yaml

# -----------------------------------------------------------------------------
# Stage 2: Frontend Builder
# -----------------------------------------------------------------------------
FROM oven/bun:1 AS frontend_builder
WORKDIR /app/frontend

# Copy frontend source and generated code
COPY frontend/package.json frontend/bun.lock ./
RUN bun install --frozen-lockfile

COPY frontend .
# Copy generated frontend protobuf code from generator stage
COPY --from=generator /workspace/frontend/src/gen ./src/gen

# Build the React app
# VITE_API_URL can be set to /api since we are serving from the same origin,
# or left empty if the client automatically uses relative paths.
ENV VITE_API_URL="" 
RUN bun run build

# -----------------------------------------------------------------------------
# Stage 3: Backend Builder
# -----------------------------------------------------------------------------
FROM golang:1.25-alpine AS backend_builder
WORKDIR /app/backend

# Copy go.mod and go.sum
COPY backend/go.mod backend/go.sum ./
RUN go mod download

# Copy backend source
COPY backend .

# Copy generated backend code from generator stage
COPY --from=generator /workspace/backend/gen ./gen
COPY --from=generator /workspace/backend/internal/db/gen ./internal/db/gen

# Copy built frontend assets into the embedded directory
# We must create the directory first
RUN mkdir -p internal/server/dist
COPY --from=frontend_builder /app/frontend/dist ./internal/server/dist

# Build the static binary
# CGO_ENABLED=0 is critical for alpine compatibility
RUN CGO_ENABLED=0 GOOS=linux go build -o /server ./cmd/server/main.go

# -----------------------------------------------------------------------------
# Stage 4: Final Runner
# -----------------------------------------------------------------------------
FROM alpine:latest

# Install basic certificates for HTTPS calls if needed
RUN apk --no-cache add ca-certificates

WORKDIR /root/

# Copy binary from builder
COPY --from=backend_builder /server .

# Install Atlas for migrations (optional, since you said you'd handle it manually, 
# but good to have if you change your mind. I'll comment it out for now to save space).
# COPY --from=arigaio/atlas:latest /atlas /usr/local/bin/atlas

# Expose port
EXPOSE 8080

# Run the server
CMD ["./server"]
