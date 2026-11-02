import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("../", import.meta.url));
await mkdir(join(web, "build"), { recursive: true });
const scratch = await mkdtemp(join(web, "build/deploy-test-"));
const repository = join(scratch, "repository with spaces");
const fixtureWeb = join(repository, "web");
const dist = join(fixtureWeb, "dist");

// Exercise real Git refs and indexes, confined to a disposable repository.
function run(command, args, cwd = repository, expected = 0) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  assert.equal(result.status, expected, result.error?.message ?? result.stderr);
  return result.stdout.trim();
}

const git = (...args) => run("git", args);
const deploy = (expected = 0) => run("bash", [join(fixtureWeb, "deploy.sh")], scratch, expected);
const tip = () => git("rev-parse", "refs/heads/web");

try {
  await mkdir(dist, { recursive: true });
  await copyFile(join(web, "deploy.sh"), join(fixtureWeb, "deploy.sh"));
  git("init", "--initial-branch=main");
  git("config", "user.name", "Deployment test");
  git("config", "user.email", "deploy@example.invalid");
  await writeFile(join(repository, ".gitignore"), "web/dist/\n*.bin\n");
  await writeFile(join(repository, "source.txt"), "committed source\n");
  git("add", ".");
  git("commit", "-m", "test: initialize source");

  // The main checkout contains both staged and unstaged edits during deployment.
  await writeFile(join(repository, "source.txt"), "staged source\n");
  git("add", "source.txt");
  await writeFile(join(repository, "source.txt"), "unstaged source\n");
  const sourceHead = git("rev-parse", "HEAD");
  const sourceIndex = await readFile(join(repository, ".git/index"));

  await writeFile(join(dist, "index.html"), "built page\n");
  await writeFile(join(dist, ".nojekyll"), "");
  await writeFile(join(dist, "revision.txt"), "abc1234-dirty\n");
  await writeFile(join(dist, "old.bin"), "old asset\n");
  await writeFile(join(dist, ".old-hidden"), "old hidden asset\n");
  deploy();
  const first = tip();
  assert.equal(
    git("rev-list", "--count", "refs/heads/web"),
    "1",
    "New publishing branches have no source history",
  );
  assert.equal(
    git("show", "-s", "--format=%s", "refs/heads/web"),
    "chore: update the web site with abc1234-dirty",
  );
  assert.equal(
    git("ls-tree", "-r", "--name-only", "refs/heads/web"),
    ".nojekyll\n.old-hidden\nindex.html\nold.bin\nrevision.txt",
  );
  assert.equal(git("show", "web:old.bin"), "old asset");

  // Each deployment replaces the complete tree, removing obsolete assets and dotfiles.
  await rm(join(dist, "old.bin"));
  await rm(join(dist, ".old-hidden"));
  await mkdir(join(dist, "assets"));
  await writeFile(join(dist, "assets/new.bin"), "new asset\n");
  await writeFile(join(dist, "revision.txt"), "def5678\n");
  deploy();
  const second = tip();
  assert.equal(git("rev-parse", "web^"), first);
  assert.equal(
    git("show", "-s", "--format=%s", "refs/heads/web"),
    "chore: update the web site with def5678",
  );
  assert.equal(
    git("ls-tree", "-r", "--name-only", "refs/heads/web"),
    ".nojekyll\nassets/new.bin\nindex.html\nrevision.txt",
  );
  assert.equal(git("show", "web:assets/new.bin"), "new asset");
  assert.equal(git("rev-parse", "HEAD"), sourceHead);
  assert.equal(git("symbolic-ref", "--short", "HEAD"), "main");
  assert.deepEqual(await readFile(join(repository, ".git/index")), sourceIndex);
  assert.equal(await readFile(join(repository, "source.txt"), "utf8"), "unstaged source\n");

  assert.match(deploy(), /already matches/);
  assert.equal(tip(), second, "Unchanged builds must not create commits");

  for (const file of ["index.html", ".nojekyll", "revision.txt"]) {
    const path = join(dist, file);
    const contents = await readFile(path);
    await rm(path);
    deploy(1);
    assert.equal(tip(), second, `Missing ${file} must preserve the branch`);
    await writeFile(path, contents);
  }
  await writeFile(join(dist, "revision.txt"), "invalid revision\n");
  deploy(1);
  assert.equal(tip(), second, "Invalid build metadata must preserve the branch");
  await writeFile(join(dist, "revision.txt"), "def5678\n");

  const checkout = join(scratch, "publishing checkout");
  git("worktree", "add", checkout, "web");
  deploy(1);
  assert.equal(tip(), second, "A checked-out publishing branch must not move");
  git("worktree", "remove", checkout);

  git("checkout", "--detach");
  const detachedIndex = await readFile(join(repository, ".git/index"));
  await writeFile(join(dist, "index.html"), "another built page\n");
  deploy();
  assert.equal(git("rev-parse", "HEAD"), sourceHead, "Detached source HEAD must stay intact");
  assert.deepEqual(await readFile(join(repository, ".git/index")), detachedIndex);
  console.log(
    "Deployment replacement, history, input checks and checkout/index preservation: passed",
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
