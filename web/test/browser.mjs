// Run against a Python-served web/dist, with an installed Chromium browser.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN ?? "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox"],
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // Observe actual worker requests so controls are tested beyond their DOM values.
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    globalThis.runRequests = [];
    Worker.prototype.postMessage = function (message, ...transfer) {
      if (message?.type === "run") globalThis.runRequests.push(message.budget);
      return post.call(this, message, ...transfer);
    };
  });

  const errors = [];
  const liveWorkers = new Set();
  page.on("worker", (worker) => {
    liveWorkers.add(worker);
    worker.on("close", () => liveWorkers.delete(worker));
  });

  const requests = [];
  const downloads = [];
  page.on("download", (download) => downloads.push(download));
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));
  await page.goto(process.env.WEB_TEST_URL ?? "http://127.0.0.1:8000/");

  const theme = readFileSync(new URL("../../scripts/visualize_theme.css", import.meta.url), "utf8");
  const purple = /--purple:\s*([^;]+);/.exec(theme)[1];
  assert.equal(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--purple").trim(),
    ),
    purple,
  );

  const colors = await page.locator("#run").evaluate((button) => {
    const reference = document.createElement("span");
    reference.style.color = "var(--purple)";
    button.append(reference);
    const result = {
      actual: getComputedStyle(button).backgroundColor,
      expected: getComputedStyle(reference).color,
    };
    reference.remove();
    return result;
  });
  assert.equal(colors.actual, colors.expected);

  async function check(expected) {
    await page.locator("#run").click();
    await page.waitForFunction(
      () => !document.querySelector("#run").disabled,
      {},
      { timeout: 65000 },
    );
    const verdict = await page.locator("#verdict").innerText();
    assert.equal(verdict, expected, await page.locator("#output").innerText());
  }

  async function workersClosed() {
    const deadline = Date.now() + 5000;
    while (liveWorkers.size && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(liveWorkers.size, 0, "Search and checker workers must be closed");
  }

  async function details(verdict) {
    await page.locator('[data-view="goals"]').click();
    await page.locator("#show-details").click();
    const view = page.frameLocator("#details-frame");
    await view.locator(".goal-card").first().waitFor();
    assert.equal(await view.locator("#verdict").innerText(), `Final: ${verdict}`);
    return view;
  }

  async function save(verdict, offline = false) {
    const input = await page.locator("#ir").inputValue();
    await page.locator('[data-view="goals"]').click();
    const pending = page.waitForEvent("download");
    await page.locator("#save-session").click();
    const saved = await pending;
    assert.equal(saved.suggestedFilename(), "alive-next-session.zip");
    const path = await saved.path();
    assert.ok(path);
    const files = unzipSync(readFileSync(path));
    const replay = spawnSync(
      "python3",
      [fileURLToPath(new URL("check-archive.py", import.meta.url)), path, verdict],
      {
        encoding: "utf8",
        timeout: 60000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      },
    );
    assert.equal(replay.status, 0, replay.stdout + replay.stderr);
    if (replay.stdout) console.log(replay.stdout.trim());
    assert.equal(strFromU8(files["module.ll"]), input);
    const trajectory = strFromU8(files["session/trajectory.jsonl"]);
    const entries = trajectory
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(entries[0].kind, "start");
    assert.ok(files[`session/store/${entries[0].src}.ll`]);
    assert.ok(files[`session/store/${entries[0].tgt}.ll`]);
    const html = strFromU8(files["session/session.html"]);
    const report = JSON.parse(
      /<script id="data" type="application\/json">(.*?)<\/script>/s.exec(html)[1],
    );
    assert.equal(report.verdict, verdict);
    if (offline) {
      const htmlPath = `${path}.html`;
      writeFileSync(htmlPath, html);
      const reportPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const remote = [];
      const failures = [];
      reportPage.on("request", (request) => {
        if (!request.url().startsWith("file:")) remote.push(request.url());
      });
      reportPage.on("pageerror", (error) => failures.push(error.message));
      try {
        await reportPage.context().setOffline(true);
        await reportPage.goto(pathToFileURL(htmlPath).href);
        await reportPage.locator(".node-main").first().click();
        await reportPage.locator('[data-view="state"]').click();
        await reportPage.locator(".syntax-code.hljs").first().waitFor();
        assert.equal(await reportPage.locator("#verdict").innerText(), `Final: ${verdict}`);
        assert.match(
          await reportPage.locator("#dialog-content").innerText(),
          /<\/script><b>quoted<\/b>/,
        );
        assert.equal(await reportPage.locator("#dialog-content b").count(), 0);
        assert.deepEqual(remote, []);
        assert.deepEqual(failures, []);
      } finally {
        await reportPage.close();
        rmSync(htmlPath, { force: true });
      }
    }
    await saved.delete();
  }

  // Failed asset promises must be evicted so a later run can load the checker.
  let failedManifest = false;
  await page.route("**/checkers.*.json", (route) => {
    if (!failedManifest) {
      failedManifest = true;
      return route.fulfill({ status: 503, body: "temporarily unavailable" });
    }
    return route.continue();
  });
  await check("Error");
  await page.locator("#examples").selectOption("Strength reduction");
  await check("Verified");
  console.log("Transient checker load failure and retry: passed");
  assert.equal(await page.locator("#check-count").innerText(), "3");
  await page.locator('[data-view="checks"]').click();
  const entries = page.locator("#checks li");
  for (const [index, checker] of ["llops reshaped", "llops respected", "alive2"].entries()) {
    const row = entries.nth(index);
    assert.match(await row.locator("button").innerText(), new RegExp(`^#${index + 1} ${checker}`));
    assert.match(await row.locator("button").innerText(), /\d+ ms$/);
    if (index < 2) {
      await row.locator("button").click();
      const answer = JSON.parse(await row.locator("pre").innerText());
      assert.equal(answer.ok, true);
      assert.equal(answer[checker.split(" ")[1]], false);
      assert.equal(typeof answer.why, "string");
    }
  }
  console.log(
    "Checks trace includes negative structural attempts and alive2 with raw responses: passed",
  );
  await page.locator('[data-view="goals"]').click();
  await page.locator(".goal").first().click();
  await page.locator("#inspector").waitFor({ state: "visible" });
  assert.match(await page.locator("#inspect-src").innerText(), /mul i32/);
  assert.match(await page.locator("#inspect-tgt").innerText(), /shl i32/);

  for (const id of ["highlight", "inspect-src", "inspect-tgt"]) {
    assert.equal(await page.locator(`#${id} code.syntax-code.language-llvm.hljs`).count(), 1);
    assert.ok((await page.locator(`#${id} .hljs-keyword`).count()) > 0);
  }
  const keywordColor = (id) =>
    page
      .locator(`#${id} .hljs-keyword`)
      .first()
      .evaluate((token) => getComputedStyle(token).color);
  assert.equal(await keywordColor("inspect-src"), await keywordColor("highlight"));
  assert.equal(await keywordColor("inspect-tgt"), await keywordColor("highlight"));
  assert.notEqual(
    await keywordColor("highlight"),
    await page.locator("#highlight").evaluate((block) => getComputedStyle(block).color),
  );
  await page.screenshot({
    path: new URL("../build/browser-inspector-preview.png", import.meta.url).pathname,
    fullPage: true,
  });

  await page.locator("#close-inspector").click();
  console.log("Browser proof and consistent LLVM highlighting in editor/source/target: passed");

  // Viewer failures must remain local to the dialog, with a retry on reopening.
  await page.route("**/visualizer.*.html", (route) =>
    route.fulfill({ status: 503, body: "retry" }),
  );
  await page.locator("#show-details").click();
  await page.waitForFunction(() =>
    document.querySelector("#details-status").textContent.includes("HTTP 503"),
  );
  assert.equal(await page.locator("#verdict").innerText(), "Verified");
  await page.locator("#close-details").click();
  await page.locator("#save-session").click();
  await page.locator("#save-error").waitFor({ state: "visible" });
  assert.match(await page.locator("#save-error").innerText(), /HTTP 503/);
  assert.equal(await page.locator("#verdict").innerText(), "Verified");
  await page.unroute("**/visualizer.*.html");
  const verifiedDetails = await details("verified");
  await verifiedDetails.locator(".node-main").first().click();
  await verifiedDetails.locator('[data-view="state"]').click();
  assert.match(await verifiedDetails.locator("#dialog-content").innerText(), /mul i32/);
  assert.match(await verifiedDetails.locator("#dialog-content").innerText(), /shl i32/);
  await verifiedDetails.locator(".syntax-code.hljs").first().waitFor();
  await verifiedDetails.locator("#close-dialog").click();
  await verifiedDetails.locator("#previous").click();
  await verifiedDetails.locator("#search").fill("__no_such_event__");
  assert.equal(await verifiedDetails.locator("#no-events").isVisible(), true);
  await page.locator("#close-details").click();
  console.log("Shared visualizer dialog, timeline, inspector and failed-load retry: passed");
  await save("verified");

  let releaseSave;
  let readySave;
  const waitingSave = new Promise((resolve) => {
    readySave = resolve;
  });
  await page.route("**/visualizer.*.html", async (route) => {
    await new Promise((resolve) => {
      releaseSave = resolve;
      readySave();
    });
    await route.continue().catch(() => {});
  });
  const beforeSave = downloads.length;
  await page.locator("#save-session").click();
  await waitingSave;

  await page.locator("#ir").press("End");
  await page.locator("#ir").press("Space");
  assert.equal(await page.locator("#verdict").innerText(), "Ready");
  assert.equal(await page.locator("#goal-count").innerText(), "0");
  assert.equal(await page.locator("#check-count").innerText(), "0");
  assert.equal(await page.locator("#show-details").isDisabled(), true);
  assert.equal(await page.locator("#save-session").isDisabled(), true);
  assert.equal(await page.locator("#save-error").isVisible(), false);
  releaseSave();
  await page.unroute("**/visualizer.*.html");
  await workersClosed();
  assert.equal(downloads.length, beforeSave, "Editing must cancel the stale archive download");
  console.log("Editing invalidates the previous result and frees its session: passed");

  await page.evaluate(() => {
    const original = File.prototype.text;
    File.prototype.text = function () {
      return this.name === "slow.ll"
        ? new Promise((resolve) => {
            globalThis.releaseFile = resolve;
          })
        : original.call(this);
    };
    globalThis.restoreFile = () => {
      File.prototype.text = original;
    };
  });
  await page
    .locator("#file")
    .setInputFiles({ name: "slow.ll", mimeType: "text/plain", buffer: Buffer.from("old input") });
  await page.locator("#examples").selectOption("Branch simplification");
  const latest = await page.locator("#ir").inputValue();
  await page.evaluate(() => {
    globalThis.releaseFile("old input");
    globalThis.restoreFile();
  });
  assert.equal(await page.locator("#ir").inputValue(), latest);
  console.log("A delayed file read cannot overwrite a newer input: passed");

  await page.locator("#examples").selectOption("Overflow counterexample");
  await check("Refuted");
  assert.match(await page.locator("#output").innerText(), /Example:/);
  assert.match(await page.locator("#output").innerText(), /Last alive2 check:/);
  console.log("Browser counterexample: passed");
  const refutedDetails = await details("counterexample");
  await refutedDetails.locator("#view-counterexample").click();
  assert.match(await refutedDetails.locator("#dialog-content").innerText(), /Example:/);
  await page.locator("#close-details").click();
  await save("counterexample");

  for (const [module, names, field] of [
    [
      `define i32 @src(i32 %x) {
entry:
  br label %exit
exit:
  ret i32 %x
}
define i32 @tgt(i32 %x) { ret i32 %x }`,
      ["llops reshaped"],
      "reshaped",
    ],
    [
      `define i32 @src(ptr %p) {
  %v = load i32, ptr %p
  ret i32 %v
}
define i32 @tgt(ptr readonly %p) memory(argmem: read) {
  %v = load i32, ptr %p
  ret i32 %v
}`,
      ["llops reshaped", "llops respected"],
      "respected",
    ],
  ]) {
    await page.locator("#ir").fill(module);
    await check("Verified");
    assert.equal(await page.locator("#check-count").innerText(), String(names.length));
    assert.match(
      await page.locator("#output").innerText(),
      new RegExp(`Last llops ${field} check:`),
    );
    await page.locator('[data-view="checks"]').click();
    assert.equal(await entries.count(), names.length);
    for (const [index, name] of names.entries())
      assert.match(await entries.nth(index).locator("button").innerText(), new RegExp(name));
    const last = entries.last();
    await last.locator("button").click();
    const answer = JSON.parse(await last.locator("pre").innerText());
    assert.equal(answer.ok, true);
    assert.equal(answer[field], true);
  }
  console.log("Successful reshaped/respected proofs are traced without alive2: passed");

  assert.deepEqual(await page.locator("#budget option").allTextContents(), [
    "5 s",
    "30 s",
    "60 s",
    "120 s",
    "300 s",
    "600 s",
    "Custom…",
  ]);
  await page.locator("#examples").selectOption("Strength reduction");
  await page.locator("#cuts").fill("3");
  await page.locator("#unfolds").fill("4");
  for (const ms of [300000, 600000]) {
    await page.locator("#budget").selectOption(String(ms));
    await check("Verified");
    assert.deepEqual(await page.evaluate(() => globalThis.runRequests.at(-1)), {
      ms,
      cuts: 3,
      unfolds: 4,
    });
  }
  await page.locator("#budget").selectOption("custom");
  assert.equal(await page.locator("#custom-budget").isVisible(), true);
  const sent = await page.evaluate(() => globalThis.runRequests.length);
  await page.locator("#custom-budget").fill("0");
  await page.locator("#run").click();
  assert.equal(
    await page.locator("#custom-budget").evaluate((input) => input.checkValidity()),
    false,
  );
  assert.equal(await page.evaluate(() => globalThis.runRequests.length), sent);
  await page.locator("#custom-budget").fill("137.5");
  await page.locator("#cuts").fill("-1");
  await page.locator("#run").click();
  assert.equal(await page.evaluate(() => globalThis.runRequests.length), sent);
  await page.locator("#cuts").fill("0");
  await page.locator("#unfolds").fill("0");
  await check("Verified");
  assert.deepEqual(await page.evaluate(() => globalThis.runRequests.at(-1)), {
    ms: 137500,
    cuts: 0,
    unfolds: 0,
  });
  await page.locator("#budget").selectOption("60000");
  assert.equal(await page.locator("#custom-budget").isVisible(), false);
  await page.locator("#cuts").fill("8");
  await page.locator("#unfolds").fill("2");
  console.log("Preset/custom timeout and cut/unfold budgets reach the worker: passed");

  await page.locator("#ir").fill(`@itv = constant i32 7
@"</script><b>quoted</b>" = constant i8 0
declare i32 @helper(i32)
define i32 @src(i32 %x) {
  %g = load i32, ptr @itv, align 4
  %r = add i32 %g, %x
  ret i32 %r
}
define i32 @tgt(i32 %x) {
  %r = add i32 %x, 7
  ret i32 %r
}`);
  await check("Verified");
  await page.locator('[data-view="goals"]').click();
  await page.locator(".goal").first().click();
  await page.locator("#inspector").waitFor({ state: "visible" });
  for (const id of ["highlight", "inspect-src", "inspect-tgt"]) {
    assert.match(await page.locator(`#${id}`).textContent(), /<b>quoted<\/b>/);
    assert.equal(await page.locator(`#${id} b`).count(), 0, "IR must stay text after highlighting");
  }
  await page.locator("#close-inspector").click();
  const quotedDetails = await details("verified");
  await quotedDetails.locator(".node-main").first().click();
  await quotedDetails.locator('[data-view="state"]').click();
  assert.match(
    await quotedDetails.locator("#dialog-content").innerText(),
    /<\/script><b>quoted<\/b>/,
  );
  assert.equal(await quotedDetails.locator("#dialog-content b").count(), 0);
  await page.locator("#close-details").click();
  await save("verified", true);
  console.log(
    "Session ZIPs include the input, native session files and an offline highlighted report: passed",
  );
  console.log(
    "LLVM splitting and highlighting preserve globals, declarations and quoted names: passed",
  );

  await page.locator("#ir").fill(`declare void @llvm.lifetime.start.p0(ptr captures(none))
declare void @llvm.lifetime.end.p0(ptr captures(none))
define i32 @src(i32 noundef %x) {
  %slot = alloca i32, align 4
  call void @llvm.lifetime.start.p0(ptr %slot)
  store i32 %x, ptr %slot, align 4
  %r = load i32, ptr %slot, align 4
  call void @llvm.lifetime.end.p0(ptr %slot)
  ret i32 %r
}
define i32 @tgt(i32 noundef %x) { ret i32 %x }`);
  await check("Verified");
  console.log("Current engine lifetime-marker preprocessing: passed");

  await page
    .locator("#ir")
    .fill("define i32 @src() { ret i32 undef }\ndefine i32 @tgt() { ret i32 0 }");
  await check("Error");
  assert.match(await page.locator("#output").innerText(), /undef/);
  await page.locator("#ir").fill("this is not LLVM IR");
  await check("Error");
  await page.locator("#ir").fill("define i32 @src() { ret i32 0 }");
  await check("Error");
  console.log("Browser input errors and undef rejection: passed");

  await page
    .locator("#ir")
    .fill("define i32 @src() { ret i32 0 }\ndefine i64 @tgt() { ret i64 0 }");
  await check("Error");
  assert.match(await page.locator("#output").innerText(), /same function type/);
  await page
    .locator("#ir")
    .fill(
      "define i32 @src() { %r = call i32 @tgt()\nret i32 %r }\ndefine i32 @tgt() { ret i32 0 }",
    );
  await check("Error");
  assert.match(await page.locator("#output").innerText(), /independent functions/);
  await page.locator("#ir").fill(`define i32 @src(i1 %c) {
entry:
  br i1 %c, label %a, label %b
a:
  %v = add i32 1, 2
  br label %b
b:
  ret i32 %v
}
define i32 @tgt(i1 %c) { ret i32 0 }`);
  await check("Error");
  assert.match(await page.locator("#output").innerText(), /dominate/);
  await page.locator("#ir").fill(`define i32 @src() { ret i32 0 }
define i32 @tgt() { ret i32 0 }
!entries = !{!0}
!0 = !{ptr @src}`);
  await check("Error");
  assert.match(await page.locator("#output").innerText(), /independent functions/);
  console.log("Unsafe or mismatched pair splitting: rejected");

  await page.locator("#examples").selectOption("Loop induction");
  await page.locator("#run").click();
  await page.waitForFunction(() => !document.querySelector("#show-details").disabled);
  await page.locator("#stop").click();
  assert.equal(await page.locator("#verdict").innerText(), "Unknown");
  await workersClosed();
  const stoppedDetails = await details("unknown");
  assert.ok((await stoppedDetails.locator(".goal-card").count()) >= 1);
  await page.locator("#close-details").click();
  await save("unknown");
  await page.locator("#examples").selectOption("Branch simplification");
  await check("Verified");
  console.log("Browser cancellation and restart: passed");

  await page.locator("#examples").selectOption("Loop induction");
  await check("Verified");
  assert.ok(
    Number(await page.locator("#goal-count").innerText()) > 1,
    "Loop proof must exercise the goal tree",
  );
  await page.locator('[data-view="goals"]').click();
  for (const goal of [page.locator(".goal").first(), page.locator(".goal").last()]) {
    const label = (await goal.innerText()).split(" ")[0];
    await goal.click();
    await page.locator("#inspector").waitFor({ state: "visible" });
    assert.equal(await page.locator("#inspect-title").innerText(), `Goal ${label}`);
    for (const id of ["inspect-src", "inspect-tgt"])
      assert.ok((await page.locator(`#${id} .hljs-keyword`).count()) > 0);
    await page.locator("#close-inspector").click();
  }
  console.log("Browser alive-simple loop decomposition: passed");

  const loopDetails = await details("verified");
  assert.ok((await loopDetails.locator(".goal-card").count()) > 1);
  const history = JSON.parse(await loopDetails.locator("#data").textContent());
  assert.equal(
    Object.keys(history.snapshots.at(-1)).length,
    Number(await page.locator("#goal-count").innerText()),
  );
  assert.ok(Object.values(history.diffs).some((pair) => pair.src.changed && !pair.src.birth));
  await page.screenshot({
    path: new URL("../build/details-preview.png", import.meta.url).pathname,
    fullPage: true,
  });
  await page.locator("#close-details").click();
  console.log("Detailed loop history, diffs, counterexamples and stopped runs: passed");
  await save("verified");

  await page.screenshot({
    path: new URL("../build/browser-preview.png", import.meta.url).pathname,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#budget").selectOption("custom");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await details("verified");
  const detailBox = await page.locator("#details").boundingBox();
  assert.ok(detailBox.x >= 0 && detailBox.x + detailBox.width <= 390);
  await page.locator("#close-details").click();
  assert.equal(
    requests.every((request) => request.method === "GET"),
    true,
  );
  assert.equal(
    requests.every((request) => new URL(request.url).origin === new URL(page.url()).origin),
    true,
    "All runtime assets, including syntax highlighting, must be served locally",
  );
  assert.deepEqual(errors, []);
  console.log("Responsive layout and static-only requests: passed");
} finally {
  await browser.close();
}
