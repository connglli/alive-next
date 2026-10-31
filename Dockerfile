FROM ubuntu:24.04

# The build dependencies of alive-next, alive2 and DeStiVa, and the agent sandbox's tools.
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential lld cmake ninja-build pkg-config \
        git curl ca-certificates unzip xz-utils zstd re2c \
        libz3-dev zlib1g-dev \
        python3 time util-linux procps \
        bubblewrap socat ripgrep \
    && rm -rf /var/lib/apt/lists/*

# bun and uv where every user finds them.
ARG BUN_VERSION=1.3.14
ARG UV_VERSION=0.11.32
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}" \
    && curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" \
      | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh

# The host user's ids, in place of the image's own user, which holds uid 1000.
ARG UID=1000
ARG GID=1000
RUN (userdel -r ubuntu || true) \
    && groupadd -o -g "$GID" itv \
    && useradd -o -m -u "$UID" -g "$GID" -s /bin/bash itv
USER itv

# elan in the user's home, where building llrwt fetches the Lean that VeIR names.
RUN curl -fsSL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh \
      | sh -s -- -y --default-toolchain none --no-modify-path
ENV PATH=/home/itv/.elan/bin:${PATH}
ENV UV_PYTHON_PREFERENCE=only-system

WORKDIR /itv
CMD ["bash"]
