# Stage 1: Build the React frontend
# Base images pinned by digest (outside review O2); Dependabot updates them.
FROM node:26-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a AS frontend-builder

WORKDIR /frontend

# Copy package files and install dependencies
COPY frontend/package*.json ./
RUN npm ci

# Copy source and build. Release builds pass no build info; other builds can pass
# BUILD_SHA / BUILD_DATE so the sidebar says which commit is running.
COPY frontend/ ./
ARG BUILD_SHA=""
ARG BUILD_DATE=""
ENV VITE_BUILD_SHA=$BUILD_SHA VITE_BUILD_DATE=$BUILD_DATE
RUN npm run build

# Stage 2: Serve with nginx
FROM nginx:alpine@sha256:df221db836e1754089190208cee7eeda94f233197056426eda74a43ab1abeac2

# Install openssl for self-signed certificate generation
RUN apk add --no-cache openssl

# Copy built frontend
COPY --from=frontend-builder /frontend/dist /usr/share/nginx/html

# Copy nginx config: the listeners, and the app they serve (#256)
COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY nginx/mtm-app.conf /etc/nginx/mtm-app.conf

# Remove default nginx config backup
RUN rm -f /etc/nginx/conf.d/default.conf.bak

# Copy and prepare entrypoint script
COPY nginx/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80 443

ENTRYPOINT ["/entrypoint.sh"]
