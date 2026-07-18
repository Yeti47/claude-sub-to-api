# ---- Build stage ----
FROM golang:1.26-alpine AS build
WORKDIR /src

# Cache dependencies first.
COPY go.mod go.sum ./
RUN go mod download

# Build a static binary.
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /out/claude-sub-to-api ./cmd/claude-sub-to-api

# ---- Runtime stage ----
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/claude-sub-to-api /claude-sub-to-api

# Run as the nonroot user provided by the base image.
USER nonroot:nonroot

# The proxy expects its data dir (containing .credentials.json) at /data by default.
VOLUME ["/data"]

EXPOSE 8080
ENTRYPOINT ["/claude-sub-to-api"]
