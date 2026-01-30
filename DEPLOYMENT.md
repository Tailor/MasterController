# MasterController Production Deployment Guide

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Docker Deployment](#docker-deployment)
4. [Kubernetes Deployment](#kubernetes-deployment)
5. [Load Balancer Configuration](#load-balancer-configuration)
6. [Redis Cluster Setup](#redis-cluster-setup)
7. [Environment Variables](#environment-variables)
8. [Health Checks & Monitoring](#health-checks--monitoring)
9. [Security Best Practices](#security-best-practices)
10. [Performance Tuning](#performance-tuning)
11. [Troubleshooting](#troubleshooting)

---

## Overview

This guide covers production deployment of MasterController applications for Fortune 500 enterprises, including:

- Horizontal scaling with load balancers
- Redis-backed distributed session/rate limiting
- Health checks for orchestration
- Monitoring with Prometheus
- Security hardening
- High availability setup

**Recommended Architecture:**

```
Internet → Load Balancer (Nginx/HAProxy)
          ↓
    [ MasterController Instance 1 ]
    [ MasterController Instance 2 ]  ←→  Redis Cluster
    [ MasterController Instance 3 ]
          ↓
    Database (PostgreSQL/MySQL/MongoDB)
```

---

## Prerequisites

- **Node.js**: v18.x or higher (LTS recommended)
- **Redis**: v6.x or higher (v7.x for Redis Cluster)
- **Load Balancer**: Nginx 1.24+, HAProxy 2.8+, or AWS ALB
- **Monitoring**: Prometheus + Grafana (optional but recommended)
- **SSL Certificates**: Let's Encrypt or commercial CA

---

## Docker Deployment

### 1. Create Dockerfile

```dockerfile
# Dockerfile
FROM node:20-alpine

# Install security updates
RUN apk upgrade --no-cache

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production --ignore-scripts

# Copy application code
COPY . .

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Set ownership
RUN chown -R nodejs:nodejs /usr/src/app

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/_health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start application
CMD ["node", "server.js"]
```

### 2. Create docker-compose.yml

```yaml
version: '3.8'

services:
  app:
    build: .
    restart: always
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      REDIS_HOST: redis
      REDIS_PORT: 6379
      SESSION_SECRET: ${SESSION_SECRET}
    depends_on:
      - redis
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:3000/_health')"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    deploy:
      replicas: 3
      resources:
        limits:
          cpus: '1'
          memory: 1G
        reservations:
          cpus: '0.5'
          memory: 512M

  redis:
    image: redis:7-alpine
    restart: always
    command: redis-server --appendonly yes --requirepass ${REDIS_PASSWORD}
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 3

  nginx:
    image: nginx:alpine
    restart: always
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./ssl:/etc/nginx/ssl:ro
    depends_on:
      - app

volumes:
  redis-data:
```

### 3. Build and Run

```bash
# Build image
docker build -t mastercontroller-app:latest .

# Run with docker-compose
docker-compose up -d

# Scale instances
docker-compose up -d --scale app=5

# View logs
docker-compose logs -f app

# Stop
docker-compose down
```

---

## Kubernetes Deployment

### 1. Create Deployment Manifest

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mastercontroller
  labels:
    app: mastercontroller
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: mastercontroller
  template:
    metadata:
      labels:
        app: mastercontroller
    spec:
      containers:
      - name: app
        image: mastercontroller-app:latest
        ports:
        - containerPort: 3000
          name: http
        env:
        - name: NODE_ENV
          value: "production"
        - name: REDIS_HOST
          value: "redis-service"
        - name: REDIS_PORT
          value: "6379"
        - name: SESSION_SECRET
          valueFrom:
            secretKeyRef:
              name: app-secrets
              key: session-secret
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 1000m
            memory: 1Gi
        livenessProbe:
          httpGet:
            path: /_health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /_health
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 2
---
apiVersion: v1
kind: Service
metadata:
  name: mastercontroller-service
spec:
  type: ClusterIP
  selector:
    app: mastercontroller
  ports:
  - protocol: TCP
    port: 80
    targetPort: 3000
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: mastercontroller-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: mastercontroller
  minReplicas: 3
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
```

### 2. Create Ingress

```yaml
# k8s/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: mastercontroller-ingress
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  tls:
  - hosts:
    - api.example.com
    secretName: mastercontroller-tls
  rules:
  - host: api.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: mastercontroller-service
            port:
              number: 80
```

### 3. Deploy to Kubernetes

```bash
# Apply configurations
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/ingress.yaml

# Check status
kubectl get pods
kubectl get svc
kubectl get ingress

# Scale deployment
kubectl scale deployment mastercontroller --replicas=5

# View logs
kubectl logs -f deployment/mastercontroller

# Rollout update
kubectl set image deployment/mastercontroller app=mastercontroller-app:v2
kubectl rollout status deployment/mastercontroller

# Rollback if needed
kubectl rollout undo deployment/mastercontroller
```

---

## Load Balancer Configuration

### Nginx Configuration

```nginx
# /etc/nginx/nginx.conf

user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {
    worker_connections 4096;
    use epoll;
    multi_accept on;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    # Logging
    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for" '
                    'rt=$request_time uct="$upstream_connect_time" '
                    'uht="$upstream_header_time" urt="$upstream_response_time"';

    access_log /var/log/nginx/access.log main;

    # Performance
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;
    client_max_body_size 50M;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/xml text/javascript
               application/json application/javascript application/xml+rss;

    # Upstream servers
    upstream mastercontroller_backend {
        least_conn;  # Load balancing algorithm

        server 10.0.1.10:3000 max_fails=3 fail_timeout=30s;
        server 10.0.1.11:3000 max_fails=3 fail_timeout=30s;
        server 10.0.1.12:3000 max_fails=3 fail_timeout=30s;

        keepalive 32;  # Connection pooling
    }

    # Rate limiting
    limit_req_zone $binary_remote_addr zone=api_limit:10m rate=100r/s;
    limit_req_zone $binary_remote_addr zone=login_limit:10m rate=5r/m;
    limit_conn_zone $binary_remote_addr zone=conn_limit:10m;

    # SSL session cache
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    server {
        listen 80;
        server_name api.example.com;

        # Redirect HTTP to HTTPS
        return 301 https://$server_name$request_uri;
    }

    server {
        listen 443 ssl http2;
        server_name api.example.com;

        # SSL Configuration
        ssl_certificate /etc/nginx/ssl/fullchain.pem;
        ssl_certificate_key /etc/nginx/ssl/privkey.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256';
        ssl_prefer_server_ciphers off;

        # Security headers
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-XSS-Protection "1; mode=block" always;

        # Rate limiting
        limit_req zone=api_limit burst=200 nodelay;
        limit_conn conn_limit 10;

        # Health check endpoint (bypass rate limiting)
        location /_health {
            access_log off;
            proxy_pass http://mastercontroller_backend;
            proxy_http_version 1.1;
            proxy_set_header Connection "";
        }

        # Metrics endpoint (restrict access)
        location /_metrics {
            allow 10.0.0.0/8;  # Internal network only
            deny all;
            proxy_pass http://mastercontroller_backend;
        }

        # API endpoints
        location / {
            proxy_pass http://mastercontroller_backend;
            proxy_http_version 1.1;

            # Headers
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header Connection "";

            # Timeouts
            proxy_connect_timeout 60s;
            proxy_send_timeout 60s;
            proxy_read_timeout 60s;

            # Buffering
            proxy_buffering on;
            proxy_buffer_size 4k;
            proxy_buffers 8 4k;
        }

        # Static files (if served by app)
        location /static/ {
            proxy_pass http://mastercontroller_backend;
            proxy_cache_valid 200 1y;
            add_header Cache-Control "public, immutable";
        }
    }
}
```

### HAProxy Configuration

```haproxy
# /etc/haproxy/haproxy.cfg

global
    maxconn 4096
    log /dev/log local0
    log /dev/log local1 notice
    chroot /var/lib/haproxy
    stats socket /run/haproxy/admin.sock mode 660 level admin
    stats timeout 30s
    user haproxy
    group haproxy
    daemon

defaults
    log global
    mode http
    option httplog
    option dontlognull
    option http-server-close
    option forwardfor except 127.0.0.0/8
    option redispatch
    retries 3
    timeout connect 5000
    timeout client 50000
    timeout server 50000
    errorfile 400 /etc/haproxy/errors/400.http
    errorfile 403 /etc/haproxy/errors/403.http
    errorfile 408 /etc/haproxy/errors/408.http
    errorfile 500 /etc/haproxy/errors/500.http
    errorfile 502 /etc/haproxy/errors/502.http
    errorfile 503 /etc/haproxy/errors/503.http
    errorfile 504 /etc/haproxy/errors/504.http

frontend http_front
    bind *:80
    bind *:443 ssl crt /etc/haproxy/certs/api.example.com.pem

    # Redirect HTTP to HTTPS
    redirect scheme https if !{ ssl_fc }

    # Security headers
    http-response set-header Strict-Transport-Security "max-age=31536000; includeSubDomains"
    http-response set-header X-Frame-Options "SAMEORIGIN"
    http-response set-header X-Content-Type-Options "nosniff"

    # Rate limiting (example)
    stick-table type ip size 100k expire 30s store http_req_rate(10s)
    http-request track-sc0 src
    http-request deny deny_status 429 if { sc_http_req_rate(0) gt 100 }

    default_backend mastercontroller_backend

backend mastercontroller_backend
    balance leastconn
    option httpchk GET /_health
    http-check expect status 200

    server app1 10.0.1.10:3000 check inter 5s fall 3 rise 2
    server app2 10.0.1.11:3000 check inter 5s fall 3 rise 2
    server app3 10.0.1.12:3000 check inter 5s fall 3 rise 2

listen stats
    bind *:8404
    stats enable
    stats uri /stats
    stats refresh 10s
    stats admin if LOCALHOST
```

---

## Redis Cluster Setup

### Single Redis Instance (Development/Small Production)

```bash
# docker-compose.yml
redis:
  image: redis:7-alpine
  command: redis-server --requirepass ${REDIS_PASSWORD} --appendonly yes
  volumes:
    - redis-data:/data
  ports:
    - "6379:6379"
```

### Redis Cluster (High Availability)

```bash
# Create Redis cluster with 6 nodes (3 masters, 3 replicas)
docker run -d --name redis-node-1 -p 7001:7001 redis:7-alpine redis-server --port 7001 --cluster-enabled yes
docker run -d --name redis-node-2 -p 7002:7002 redis:7-alpine redis-server --port 7002 --cluster-enabled yes
docker run -d --name redis-node-3 -p 7003:7003 redis:7-alpine redis-server --port 7003 --cluster-enabled yes
docker run -d --name redis-node-4 -p 7004:7004 redis:7-alpine redis-server --port 7004 --cluster-enabled yes
docker run -d --name redis-node-5 -p 7005:7005 redis:7-alpine redis-server --port 7005 --cluster-enabled yes
docker run -d --name redis-node-6 -p 7006:7006 redis:7-alpine redis-server --port 7006 --cluster-enabled yes

# Create cluster
docker exec -it redis-node-1 redis-cli --cluster create \
  127.0.0.1:7001 127.0.0.1:7002 127.0.0.1:7003 \
  127.0.0.1:7004 127.0.0.1:7005 127.0.0.1:7006 \
  --cluster-replicas 1
```

### Application Configuration

```javascript
// server.js
const Redis = require('ioredis');
const { RedisSessionStore } = require('./security/adapters/RedisSessionStore');
const { RedisRateLimiter } = require('./security/adapters/RedisRateLimiter');

// Single instance
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD,
  retryStrategy: (times) => Math.min(times * 50, 2000)
});

// OR Redis Cluster
const redis = new Redis.Cluster([
  { host: 'redis-node-1', port: 7001 },
  { host: 'redis-node-2', port: 7002 },
  { host: 'redis-node-3', port: 7003 }
], {
  redisOptions: {
    password: process.env.REDIS_PASSWORD
  }
});

// Use Redis adapters
const sessionStore = new RedisSessionStore(redis);
const rateLimiter = new RedisRateLimiter(redis);

master.session.setStore(sessionStore);
master.pipeline.use(rateLimiter.middleware());
```

---

## Environment Variables

### Required Variables

```bash
# .env.production
NODE_ENV=production

# Server
PORT=3000
HOST=0.0.0.0

# Redis
REDIS_HOST=redis.example.com
REDIS_PORT=6379
REDIS_PASSWORD=your-secure-password

# Session
SESSION_SECRET=your-very-long-random-secret-key-min-32-chars
SESSION_NAME=mastercontroller.sid
SESSION_TTL=86400

# Security
CSRF_SECRET=another-long-random-secret
ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com

# Rate Limiting
RATE_LIMIT_POINTS=100
RATE_LIMIT_DURATION=60
RATE_LIMIT_BLOCK_DURATION=300

# Logging
LOG_LEVEL=info
LOG_FILE=/var/log/mastercontroller/app.log

# Monitoring
PROMETHEUS_ENABLED=true
HEALTH_CHECK_ENABLED=true

# Database (if applicable)
DATABASE_URL=postgresql://user:pass@db.example.com:5432/myapp
```

### Optional Variables

```bash
# Performance
MAX_BODY_SIZE=10485760
MAX_JSON_SIZE=1048576
STREAM_THRESHOLD=1048576

# SSL/TLS
SSL_CERT_PATH=/etc/ssl/certs/cert.pem
SSL_KEY_PATH=/etc/ssl/private/key.pem

# Monitoring integrations
SENTRY_DSN=https://xxx@sentry.io/xxx
DATADOG_API_KEY=your-datadog-api-key
NEW_RELIC_LICENSE_KEY=your-newrelic-key
```

---

## Health Checks & Monitoring

### Enable Health Check Endpoint

```javascript
// server.js
const { healthCheck, createRedisCheck } = require('./monitoring/HealthCheck');

// Add custom health checks
healthCheck.addCheck('redis', createRedisCheck(redis));
healthCheck.addCheck('database', async () => {
  try {
    await db.ping();
    return { healthy: true };
  } catch (error) {
    return { healthy: false, error: error.message };
  }
});

// Register middleware
master.pipeline.use(healthCheck.middleware());
```

### Enable Prometheus Metrics

```javascript
const { prometheusExporter } = require('./monitoring/PrometheusExporter');

// Register middleware (tracks all HTTP requests)
master.pipeline.use(prometheusExporter.middleware());

// Custom metrics
prometheusExporter.registerMetric('orders_total', 'counter', 'Total orders processed');
prometheusExporter.incrementCounter('orders_total');
```

### Grafana Dashboard

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'mastercontroller'
    static_configs:
      - targets: ['app1:3000', 'app2:3000', 'app3:3000']
    metrics_path: '/_metrics'
    scrape_interval: 15s
```

### Alerting (Prometheus AlertManager)

```yaml
# alerts.yml
groups:
  - name: mastercontroller
    rules:
      - alert: HighErrorRate
        expr: rate(mastercontroller_http_requests_total{status=~"5.."}[5m]) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High error rate detected"

      - alert: HighMemoryUsage
        expr: process_memory_heap_used_bytes / process_memory_heap_total_bytes > 0.9
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Memory usage above 90%"

      - alert: HighLatency
        expr: histogram_quantile(0.95, mastercontroller_http_request_duration_seconds_bucket) > 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "95th percentile latency above 1 second"
```

---

## Security Best Practices

### 1. SSL/TLS Configuration

```bash
# Generate Let's Encrypt certificate
certbot certonly --webroot -w /var/www/html -d api.example.com

# Auto-renewal
echo "0 0 * * * certbot renew --quiet" | crontab -
```

### 2. Secrets Management

```bash
# Use environment variables (never commit to Git)
export SESSION_SECRET=$(openssl rand -base64 32)
export REDIS_PASSWORD=$(openssl rand -base64 32)

# Or use secrets management tools
# - HashiCorp Vault
# - AWS Secrets Manager
# - Azure Key Vault
# - Kubernetes Secrets
```

### 3. Firewall Rules

```bash
# UFW (Ubuntu)
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow from 10.0.0.0/8 to any port 6379  # Redis (internal only)
ufw deny 6379  # Block external Redis access
ufw enable

# iptables
iptables -A INPUT -p tcp --dport 80 -j ACCEPT
iptables -A INPUT -p tcp --dport 443 -j ACCEPT
iptables -A INPUT -p tcp --dport 6379 -s 10.0.0.0/8 -j ACCEPT
iptables -A INPUT -p tcp --dport 6379 -j DROP
```

### 4. Security Headers (Already in Nginx/HAProxy configs above)

- `Strict-Transport-Security`
- `X-Frame-Options`
- `X-Content-Type-Options`
- `Content-Security-Policy`

### 5. Rate Limiting

Enable Redis-based rate limiting:

```javascript
const { RedisRateLimiter } = require('./security/adapters/RedisRateLimiter');

const rateLimiter = new RedisRateLimiter(redis, {
  points: 100,           // 100 requests
  duration: 60,          // per minute
  blockDuration: 300     // block for 5 minutes on exceed
});

master.pipeline.use(rateLimiter.middleware({
  keyGenerator: (ctx) => ctx.request.connection.remoteAddress
}));
```

---

## Performance Tuning

### Node.js Settings

```bash
# Increase memory limit
NODE_OPTIONS="--max-old-space-size=2048"

# Enable V8 optimizations
NODE_OPTIONS="--optimize-for-size"

# Cluster mode (multi-core)
pm2 start server.js -i max
```

### Redis Optimization

```conf
# redis.conf
maxmemory 2gb
maxmemory-policy allkeys-lru
save 900 1
save 300 10
appendonly yes
appendfsync everysec
```

### Load Testing

```bash
# Install Apache Bench
apt install apache2-utils

# Test
ab -n 10000 -c 100 https://api.example.com/

# Or use k6
k6 run --vus 100 --duration 30s loadtest.js
```

---

## Troubleshooting

### Check Logs

```bash
# Docker
docker logs -f mastercontroller-app

# Kubernetes
kubectl logs -f deployment/mastercontroller

# PM2
pm2 logs

# System logs
journalctl -u mastercontroller -f
```

### Common Issues

**Issue: High memory usage**
```bash
# Check memory
node --inspect server.js
# Connect Chrome DevTools to inspect heap

# Analyze
npm install -g clinic
clinic doctor -- node server.js
```

**Issue: Redis connection failures**
```bash
# Test Redis connectivity
redis-cli -h redis.example.com -p 6379 ping

# Check Redis logs
docker logs redis

# Verify password
redis-cli -h redis.example.com -a your-password ping
```

**Issue: 502 Bad Gateway (Load Balancer)**
```bash
# Check upstream health
curl http://10.0.1.10:3000/_health

# Verify load balancer config
nginx -t
haproxy -c -f /etc/haproxy/haproxy.cfg
```

---

## Support

For issues and questions:

- GitHub Issues: https://github.com/Tailor/MasterController/issues
- Documentation: https://github.com/Tailor/MasterController#readme
- Security Issues: security@mastercontroller.io (if applicable)

---

**Last Updated:** 2026-01-29
**Version:** 1.0.0
