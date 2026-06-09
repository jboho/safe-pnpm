#!/bin/sh
if [ -f /usr/local/share/ca-certificates/custom-ca.crt ]; then
  export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/custom-ca.crt
fi
exec "$@"
