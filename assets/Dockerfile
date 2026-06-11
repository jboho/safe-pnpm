# Pinned for reproducibility — a floating tag could pull a compromised image.
# To harden further, pin by digest (resolved in your build environment):
#   docker buildx imagetools inspect node:22.22.3-alpine3.24
#   FROM node:22.22.3-alpine3.24@sha256:<digest>
FROM node:22.22.3-alpine3.24
ARG CUSTOM_CA=""
ARG PNPM_VERSION=11.5.3
ARG YARN_VERSION=1.22.22

RUN apk add --no-cache ca-certificates && \
    if [ -n "$CUSTOM_CA" ]; then \
      printf '%s' "$CUSTOM_CA" > /usr/local/share/ca-certificates/custom-ca.crt && \
      update-ca-certificates; \
    fi

RUN if [ -f /usr/local/share/ca-certificates/custom-ca.crt ]; then \
      NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/custom-ca.crt npm install -g "pnpm@${PNPM_VERSION}" "yarn@${YARN_VERSION}"; \
    else \
      npm install -g "pnpm@${PNPM_VERSION}" "yarn@${YARN_VERSION}"; \
    fi

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
WORKDIR /app
ENTRYPOINT ["/entrypoint.sh"]
