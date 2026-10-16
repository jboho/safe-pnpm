# Pinned by digest for reproducibility — a floating tag could pull a compromised
# image. This tag/digest ships yarn 1.22.22, so only pnpm is installed below.
# To refresh: docker buildx imagetools inspect node:24.21.0-alpine3.24
FROM node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
ARG CUSTOM_CA=""
ARG PNPM_VERSION=11.5.3

RUN apk add --no-cache ca-certificates && \
    if [ -n "$CUSTOM_CA" ]; then \
      printf '%s' "$CUSTOM_CA" > /usr/local/share/ca-certificates/custom-ca.crt && \
      update-ca-certificates; \
    fi

# yarn 1.22.22 is bundled in the base image (pinned via the digest above);
# only pnpm needs installing.
RUN if [ -f /usr/local/share/ca-certificates/custom-ca.crt ]; then \
      NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/custom-ca.crt npm install -g "pnpm@${PNPM_VERSION}"; \
    else \
      npm install -g "pnpm@${PNPM_VERSION}"; \
    fi

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
WORKDIR /app
ENTRYPOINT ["/entrypoint.sh"]
