#!/bin/sh
# Lab only: a throwaway private CA and a server certificate for s3.example.internal.
# /pki (fixture side) receives the server key and chain, /ca (probe side) only the
# public CA certificate. The CA key never leaves this container.
set -eu
umask 077
work="$(mktemp -d)"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=pluton-probe-lab-ca' \
	-keyout "$work/ca.key" -out /ca/ca.pem \
	-addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj '/CN=s3.example.internal' \
	-keyout /pki/server.key -out "$work/server.csr" 2>/dev/null
printf '%s\n' 'subjectAltName=DNS:s3.example.internal' 'basicConstraints=critical,CA:FALSE' \
	'keyUsage=critical,digitalSignature,keyEncipherment' 'extendedKeyUsage=serverAuth' >"$work/server.ext"
openssl x509 -req -in "$work/server.csr" -CA /ca/ca.pem -CAkey "$work/ca.key" -set_serial 1 -days 2 \
	-extfile "$work/server.ext" -out "$work/server.pem" 2>/dev/null
cat "$work/server.pem" /ca/ca.pem >/pki/server-chain.pem
chmod 0644 /ca/ca.pem /pki/server-chain.pem
chmod 0600 /pki/server.key
rm -rf "$work"
