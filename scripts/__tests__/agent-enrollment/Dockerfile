FROM ubuntu:22.04@sha256:0a9887931b0e38af2e3487ed39e29436b0535c4f3f52e57745baaf79d1898956
LABEL io.pluton.test.scope="standalone-enrollment"
RUN apt-get update --error-on=any && apt-get install -y --no-install-recommends \
    ca-certificates curl git python3 openssl sudo systemd xz-utils bzip2 unzip \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
WORKDIR /opt/enrollment-test
COPY . .
RUN chmod 0755 systemctl-fixture.sh && install -m 0755 systemctl-fixture.sh /usr/local/bin/systemctl \
    && touch /opt/pluton-disposable-ubuntu-test && chmod 0600 /opt/pluton-disposable-ubuntu-test
ENV PLUTON_DISPOSABLE_INSTALL_TEST=1
RUN bash verify.sh
