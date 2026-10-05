# Pinned by digest for reproducibility — a floating tag could pull a compromised
# image. This tag/digest ships yarn 1.22.22, so only pnpm is installed below.
# To refresh: docker buildx imagetools inspect node:22.22.3-alpine3.24
FROM node:26.10.0-alpine3.24@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80
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
