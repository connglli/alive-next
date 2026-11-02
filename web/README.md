# Web interface

Check LLVM IR refinement with alive-simple in the browser. Edit source and target functions on the left, then inspect the result, individual checks and goal tree on the right. The interface uses Compiler Explorer's two-pane layout and the project's visualizer styling.

The website is published at https://connglli.github.io/alive-next/. Verification runs in your browser; the host serves static files.

## Build

For a local build, prepare the project dependencies as described in the [main README](../README.md#build). From the repository root:

```sh
make install-deps
./web/build.sh
```

The web build also needs Node.js, Python 3, and the host tools reported by `build.sh`. It checks `make deps-status` and stops if a project dependency is missing. Its first run downloads the additional web build tools. Subsequent builds reuse downloaded tools and compiled dependencies. Use `./web/build.sh --jobs N` to change compilation parallelism; the default is two jobs.

## Serve locally

Serve the built site from the repository root:

```sh
python3 -m http.server 8000 --directory web/dist
```

Open http://localhost:8000/ and provide an LLVM IR module defining `@src` and `@tgt` with matching function types.

## Serve remotely

Commit the built site to the local `web` branch from the repository root:

```sh
./web/deploy.sh
git push -f origin web:web
```

Open https://connglli.github.io/alive-next/ and provide an LLVM IR module defining `@src` and `@tgt` with matching function types.

## Developers

[DEVELOPERS.md](./DEVELOPERS.md) saves implementation, toolchain, tests and publishing documentation.
