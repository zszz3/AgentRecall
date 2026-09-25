// Layout assertions run inside the existing isolated native smoke process.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function verifyUiQuality({ evaluate, electron, outputRoot, home }) {
  const window = `${electron}.BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/renderer/index.html'))`;
  const renderer = (fn, argument) => evaluate(`${window}.webContents.executeJavaScript(${JSON.stringify(`(${fn.toString()})(${JSON.stringify(argument) ?? "undefined"})`)})`);
  let screenshotCount = 0;
  const screenshot = async (name) => {
    const png = await evaluate(`(async () => (await ${window}.webContents.capturePage()).toPNG().toString('base64'))()`);
    await fs.writeFile(path.join(outputRoot, name + ".png"), Buffer.from(png, "base64"));
    screenshotCount++;
  };
  const input = event => evaluate(`${electron}.app.focus({steal:true}); ${window}.focus(); ${window}.webContents.focus(); ${window}.webContents.sendInputEvent(${JSON.stringify(event)}); undefined`);
  const press = async keyCode => {
    await input({ type: 'keyDown', keyCode });
    // Electron injects key and character events separately. Native button
    // activation needs the same character event a physical key would produce.
    if (keyCode === 'Enter' || keyCode === 'Space') {
      await input({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : ' ' });
    }
    await input({ type: 'keyUp', keyCode });
    await delay(60);
  };
  const waitFor = async (predicate, description, argument) => {
    const deadline = Date.now() + 10_000;
    while (!(await renderer(predicate, argument))) {
      if (Date.now() > deadline) throw Error(description);
      await delay(100);
    }
  };
  const navigate = async (page) => {
    await renderer((page) => document.querySelector(`.app-navigation button[data-page="${page}"]`).click(), page);
    await waitFor(page => {
      const roots = { workbench: '.workbench-page', sessions: '.sessions-page', providers: '.provider-page',
        runtimes: '.automation-runtime-page', workflows: '.automation-workflow-page', skills: '.skills-page',
        memories: '.openviking-memory-page', 'team-chat': '.team-chat-page', mcp: '.automation-mcp-page' };
      return document.querySelector(`.app-navigation button[data-page="${page}"]`)?.getAttribute('aria-current') === 'page'
        && Boolean(document.querySelector(`.app-page-host ${roots[page] ?? '.app-page-head'}`));
    }, `Page did not mount: ${page}`, page);
    await delay(450);
  };
  const sizes = [[860, 800], [1000, 800], [1100, 800], [1200, 820], [1279, 820], [1280, 820], [1439, 900], [1440, 900], [1728, 1117], [2048, 1286]];
  const results = [];
  const extendedMatrix = [];
  // Inspect compact actions, not intentionally multiline list cards or forms.
  const readResponsiveLayout = page => {
    const visible = el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight
        && getComputedStyle(el).visibility !== 'hidden';
    };
    const controls = [...document.querySelectorAll([
      '.app-page-host .control-btn', '.app-page-host .send-btn',
      '.managed-skills-toolbar-actions button', '.managed-skill-actions button',
      '.skill-library-tab', '.settings-action-button', '.settings-sidebar button span',
    ].join(','))].filter(el => visible(el) && el.textContent.trim()).map(el => {
      const r = el.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(el);
      const text = range.getBoundingClientRect();
      return { text: el.textContent.trim(), nowrap: getComputedStyle(el).whiteSpace,
        overflow: el.scrollWidth - el.clientWidth,
        textFits: text.left >= r.left - 1 && text.right <= r.right + 1 && text.top >= r.top - 1 && text.bottom <= r.bottom + 1 };
    });
    const surfaces = [...document.querySelectorAll([
      '.app-workspace', '.app-page-host', '.runtime-config-workspace', '.runtime-editor',
      '.workflow-core-shell', '.workflow-core-main', '.managed-skills-grid', '.managed-skill-detail',
      '.settings-dialog', '.settings-body', '.settings-main', '.settings-pane',
    ].join(','))].filter(visible).map(el => ({ selector: el.className, overflow: el.scrollWidth - el.clientWidth }));
    const splits = [...document.querySelectorAll('.resizable-split')].filter(visible).map(el => {
      const outer = el.getBoundingClientRect();
      return { stacked: el.dataset.stacked, width: outer.width,
        panes: [...el.children].filter(child => visible(child) && !child.matches('.pane-resize-handle')).map(child => {
          const r = child.getBoundingClientRect();
          return { selector: child.className, width: r.width, contained: r.left >= outer.left - 1 && r.right <= outer.right + 1 };
        }) };
    });
    const workspace = document.querySelector('.app-workspace').getBoundingClientRect();
    const navigation = document.querySelector('.app-navigation').getBoundingClientRect();
    const dialog = document.querySelector('.settings-dialog')?.getBoundingClientRect();
    return { page, width: innerWidth, height: innerHeight, navigationWidth: navigation.width,
      usableWidth: workspace.width, controls, surfaces, splits,
      dialogContained: !dialog || (dialog.left >= 0 && dialog.right <= innerWidth && dialog.top >= 0 && dialog.bottom <= innerHeight) };
  };
  const assertResponsiveLayout = layout => {
    for (const surface of layout.surfaces) assert.ok(surface.overflow <= 1, JSON.stringify({ page: layout.page, width: layout.width, surface }));
    for (const control of layout.controls) {
      assert.equal(control.nowrap, 'nowrap', JSON.stringify({ page: layout.page, width: layout.width, control }));
      assert.ok(control.overflow <= 1 && control.textFits, JSON.stringify({ page: layout.page, width: layout.width, control }));
    }
    for (const split of layout.splits) assert.ok(split.panes.every(pane => pane.width > 0 && pane.contained), JSON.stringify({ page: layout.page, width: layout.width, split }));
    assert.ok(layout.dialogContained, JSON.stringify(layout));
  };
  const seedUsageNumbers = () => {
    document.querySelectorAll('.usage-metrics strong').forEach((el, index) => {
      el.textContent = ['999.9K', '99.9K', '999.9M', '98.1%'][index];
    });
    document.querySelector('.workbench-detail-title span').textContent = localStorage.getItem('agent-recall-language') === 'zh'
      ? '缓存命中占输入 98.1%' : 'Cache hits cover 98.1% of input';
  };
  const readOverviewDetails = () => ({
    caption: (() => {
      const el = document.querySelector('.workbench-detail-title span');
      return {overflow:el.scrollWidth - el.clientWidth, ellipsis:getComputedStyle(el).textOverflow};
    })(),
    plotHeight: document.querySelector('.workbench-token-trend-canvas').getBoundingClientRect().height,
    metrics: [...document.querySelectorAll('.usage-metrics strong')].map(el => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const text = range.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return { text: el.textContent, width: box.width, textWidth: text.width,
        fontSize: parseFloat(getComputedStyle(el).fontSize), clipped: text.width > box.width + 1 };
    }),
    quota: [...document.querySelectorAll('.workbench-quota')].map(el => ({
      iconWidth: el.querySelector('.quota-identity > i').getBoundingClientRect().width,
      iconHeight: el.querySelector('.quota-identity > i').getBoundingClientRect().height,
      nameSize: parseFloat(getComputedStyle(el.querySelector('.quota-identity strong')).fontSize),
      contentGap: el.children[1].getBoundingClientRect().top - el.children[0].getBoundingClientRect().top,
      overflow: el.scrollWidth - el.clientWidth,
    })),
    trendSummaryGap: document.querySelector('.workbench-token-trend-foot > span').getBoundingClientRect().top
      - document.querySelector('.workbench-token-trend-labels').getBoundingClientRect().bottom,
  });
  const assertOverviewDetails = details => {
    assert.ok(details.caption.overflow <= 1 && details.caption.ellipsis !== 'ellipsis', JSON.stringify(details.caption));
    assert.ok(details.plotHeight > 0, JSON.stringify(details.plotHeight));
    for (const metric of details.metrics) {
      assert.equal(metric.clipped, false, JSON.stringify(metric));
      assert.ok(metric.fontSize >= 16 && metric.fontSize <= 26, JSON.stringify(metric));
    }
    for (const quota of details.quota) {
      // Fractional browser zoom rounds CSS pixels to subpixel geometry.
      assert.ok(Math.abs(quota.iconWidth - quota.iconHeight) <= .5 && quota.iconWidth >= quota.nameSize * 1.5, JSON.stringify(quota));
      assert.ok(quota.nameSize >= 11, JSON.stringify(quota));
      assert.ok(Math.abs(quota.contentGap) <= 1 && quota.overflow <= 1, JSON.stringify(quota));
    }
    assert.ok(details.trendSummaryGap > 0, JSON.stringify(details));
  };
  for (const language of ["zh", "en"]) {
    await renderer(language => localStorage.setItem('agent-recall-language', language), language);
    await evaluate(`${window}.webContents.reload(); undefined`);
    await delay(1200);
  for (const [width, height] of sizes) {
    await evaluate(`${window}.setContentSize(${width}, ${height}); undefined`);
    await delay(250);
    for (const page of ["workbench", "sessions", "providers"]) {
      await navigate(page);
      if (page === 'workbench') await renderer(seedUsageNumbers);
      if (page === "sessions") {
        const deadline = Date.now() + 30_000;
        while (!(await renderer(() => document.querySelectorAll(".session-row").length >= 3))) {
          if (Date.now() > deadline) throw Error("Synthetic sessions did not finish indexing");
          await delay(250);
        }
        await renderer(() => {
          document.querySelectorAll('.section-header[aria-expanded="false"], .tree-chevron[aria-expanded="false"]')
            .forEach(button => button.click());
        });
        await delay(200);
      }
      if (page === "providers") {
        await waitFor(() => document.querySelector('.provider-path-input input') instanceof HTMLInputElement,
          'Provider configuration input did not become ready');
        await renderer(() => {
          [...document.querySelectorAll('.api-provider-switch button')]
            .find(button => button.querySelector('strong')?.textContent === 'Custom')?.click();
        });
        await delay(100);
        await renderer((home) => {
          const input = document.querySelector(".provider-path-input input");
          const value = home + "/" + "long-configuration-directory/".repeat(10);
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }, home);
        const pathDeadline = Date.now() + 10_000;
        while (!(await renderer(home => document.querySelector('.codex-config-visualizer strong[title]')?.title.startsWith(home), home))) {
          if (Date.now() > pathDeadline) throw Error('Synthetic provider path did not finish loading');
          await delay(200);
        }
      }
      const geometry = await renderer((page) => {
        const rect = (element) => {
          const r = element.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        };
        const controls = [...document.querySelectorAll(".toolbar button, .bulk-result-actions button, .api-target-tabs button, .provider-path-input button, .api-config-actions button")]
          .filter(el => el.getBoundingClientRect().height && el.textContent.trim());
        const surfaces = [...document.querySelectorAll(".app-workspace, .sessions-page .content, .toolbar-secondary, .toolbar-filters, .result-count, .workbench-page-content, .api-config-body")];
        const result = { page, width: innerWidth, height: innerHeight,
          overflow: surfaces.map(el => ({ selector: el.className, overflow: el.scrollWidth - el.clientWidth })),
          controls: controls.map(el => ({ text: el.textContent.trim(), nowrap: getComputedStyle(el).whiteSpace, overflow: el.scrollWidth - el.clientWidth, ...rect(el) })),
        };
        if (page === "workbench") {
          result.cards = [...document.querySelector(".workbench-overview").children].map(rect);
          result.metricsHeaderGap = document.querySelector('.usage-metrics').getBoundingClientRect().top
            - document.querySelector('.workbench-usage-head').getBoundingClientRect().bottom;
          result.metrics = [...document.querySelectorAll('.usage-metrics strong')].map(el => {
            const range = document.createRange();
            range.selectNodeContents(el);
            const text = range.getBoundingClientRect();
            return { center: (text.left + text.right) / 2, alignment: getComputedStyle(el).textAlign };
          });
          result.legend = [...document.querySelectorAll('.workbench-token-legend > span')].map(rect);
          result.workTop = document.querySelector(".workbench-primary-grid").getBoundingClientRect().top;
        }
        if (page === "sessions") {
          result.search = rect(document.querySelector('.toolbar-primary .searchbox'));
          result.filtersTop = document.querySelector('.toolbar-secondary').getBoundingClientRect().top;
          const parent = document.querySelector(".section-header");
          const child = document.querySelector(".nav-group button");
          const font = el => ({ size: parseFloat(getComputedStyle(el).fontSize), weight: Number(getComputedStyle(el).fontWeight), ...rect(el) });
          result.tree = { heading: font(document.querySelector(".session-sidebar-title strong")), parent: font(parent), child: font(child),
            normalChild: font(document.querySelectorAll('.nav-group button')[1]),
            childRows: [...document.querySelectorAll('.nav-group button')].map(font),
            sidebar: rect(document.querySelector(".sidebar")), parentClickableWidth: parent.getBoundingClientRect().width };
          result.tags = [...document.querySelectorAll(".row-tags span")].map(el => {
            const row = el.closest(".session-row");
            const before = row.getBoundingClientRect().height;
            const full = el.textContent;
            el.textContent = "main";
            const shortHeight = row.getBoundingClientRect().height;
            el.textContent = full;
            return { title: el.title, nowrap: getComputedStyle(el).whiteSpace, ellipsis: getComputedStyle(el).textOverflow,
              clipped: el.scrollWidth > el.clientWidth, rowHeight: before, shortHeight,
              mainWidth: row.querySelector('.session-main').getBoundingClientRect().width,
              rowWidth: row.getBoundingClientRect().width, ...rect(el) };
          });
        }
        if (page === "providers") {
          const value = document.querySelector(".codex-config-visualizer strong[title]");
          result.path = { title: value.title, text: value.textContent, clipped: value.scrollWidth > value.clientWidth };
          result.formWidth = document.querySelector(".api-settings-form").getBoundingClientRect().width;
        }
        return result;
      }, page);
      geometry.language = language;
      if (page === 'workbench') {
        geometry.readability = await renderer(readOverviewDetails);
        assertOverviewDetails(geometry.readability);
      }
      await fs.writeFile(path.join(outputRoot, "ui-quality-last-geometry.json"), JSON.stringify(geometry, null, 2));
      await screenshot(`${page}-${language}-${width}x${height}`);
      assert.equal(geometry.width, width);
      for (const surface of geometry.overflow) assert.ok(surface.overflow <= 1, JSON.stringify(geometry));
      for (const control of geometry.controls) {
        assert.equal(control.nowrap, "nowrap", JSON.stringify(control));
        assert.ok(control.overflow <= 1, JSON.stringify(control));
      }
      if (geometry.tree) {
        assert.ok(geometry.search.width >= 230, JSON.stringify(geometry.search));
        assert.ok(geometry.search.bottom <= geometry.filtersTop);
        assert.ok(geometry.tree.heading.size > geometry.tree.parent.size);
        assert.ok(geometry.tree.parent.size > geometry.tree.child.size);
        assert.equal(geometry.tree.child.size, geometry.tree.normalChild.size);
        assert.ok(geometry.tree.parent.weight >= geometry.tree.normalChild.weight);
        assert.ok(geometry.tree.parentClickableWidth >= geometry.tree.sidebar.width - 32, JSON.stringify(geometry.tree));
        assert.ok(geometry.tree.child.height >= 24);
        for (const row of geometry.tree.childRows) assert.ok(Math.abs(row.height - geometry.tree.child.height) <= 1);
        assert.ok(geometry.tags.some(tag => tag.title.includes("frontend-storage-foundation")));
        assert.ok(geometry.tags.some(tag => tag.clipped));
        for (const tag of geometry.tags) {
          assert.equal(tag.nowrap, "nowrap");
          assert.equal(tag.ellipsis, "ellipsis");
          assert.equal(tag.rowHeight, tag.shortHeight);
          assert.ok(tag.mainWidth >= tag.rowWidth * .6, JSON.stringify(tag));
          if (tag.title === 'main') assert.equal(tag.clipped, false);
        }
      }
      if (geometry.cards) {
        assert.ok(geometry.metricsHeaderGap > 0, 'Usage metrics must not overlap the header controls');
        assert.equal(geometry.metrics.length, 4);
        const metricStep = geometry.metrics[1].center - geometry.metrics[0].center;
        for (let i = 0; i < geometry.metrics.length; i++) {
          assert.equal(geometry.metrics[i].alignment, 'center');
          if (i > 0) assert.ok(Math.abs(geometry.metrics[i].center - geometry.metrics[i - 1].center - metricStep) <= 1,
            'Usage metric centers must be evenly spaced');
        }
        assert.ok(Math.max(...geometry.cards.map(card => card.bottom)) < geometry.workTop);
        for (const card of geometry.cards) assert.ok(card.right <= width);
        for (let i = 1; i < geometry.legend.length; i++) {
          const previous = geometry.legend[i - 1];
          const current = geometry.legend[i];
          assert.ok(current.top >= previous.bottom || current.left >= previous.right, 'Usage legend overlaps');
        }
      }
      if (geometry.path) {
        assert.equal(geometry.path.text, geometry.path.title);
        assert.ok(geometry.path.title.startsWith(home));
        assert.ok(geometry.formWidth <= 1120, JSON.stringify(geometry.formWidth));
        if (width >= 1728) assert.ok(geometry.formWidth >= 1000);
      }
      results.push(geometry);
    }
    for (const page of ['runtimes', 'workflows', 'skills', 'settings']) {
      if (page === 'settings') {
        await renderer(() => document.querySelector('.app-navigation-settings').click());
        await waitFor(() => Boolean(document.querySelector('.settings-dialog')), 'Settings did not open');
      } else {
        await navigate(page);
        await waitFor(() => Boolean(document.querySelector('.resizable-split')), `${page} split did not load`);
      }
      try {
        const layout = { ...await renderer(readResponsiveLayout, page), language };
        await screenshot(`matrix-${page}-${language}-${width}x${height}`);
        assert.equal(layout.navigationWidth, width >= 1440 ? 200 : 84);
        assertResponsiveLayout(layout);
        extendedMatrix.push(layout);
      } finally {
        if (page === 'settings') {
          await press('Escape');
          await waitFor(() => !document.querySelector('.settings-dialog'), 'Settings did not close');
        }
      }
    }
  }
  }
  const zoomResults = [];
  try {
    await navigate('workbench');
    for (const width of [1120, 1280, 1728]) {
      await evaluate(`${window}.setContentSize(${width}, 900); undefined`);
      for (const zoom of [.8, 1, 1.25, 1.5]) {
        await evaluate(`${window}.webContents.setZoomFactor(${zoom}); undefined`);
        await delay(250);
        await renderer(seedUsageNumbers);
        const details = await renderer(readOverviewDetails);
        assertOverviewDetails(details);
        zoomResults.push({ width, zoom, ...details });
        await screenshot(`workbench-zoom-${zoom}-${width}`);
      }
    }
  } finally { await evaluate(`${window}.webContents.setZoomFactor(1); undefined`); }
  await evaluate(`${window}.setContentSize(1280, 800); undefined`);
  const otherPages = [];
  for (const page of ['team-chat', 'runtimes', 'workflows', 'evaluation', 'memories', 'skills', 'mcp']) {
    await navigate(page);
    const layout = await renderer(() => ({ overflow: document.querySelector('.app-workspace').scrollWidth - document.querySelector('.app-workspace').clientWidth,
      textLength: document.querySelector('.app-page-host').innerText.length }));
    assert.ok(layout.textLength > 10);
    assert.ok(layout.overflow <= 1, JSON.stringify({page, ...layout}));
    otherPages.push({page, ...layout});
    await screenshot(`${page}-en-1280x800`);
  }
  await renderer(() => document.querySelector('.app-navigation-settings').click());
  await delay(400);
  await screenshot('settings-en-1280x800');
  assert.ok(await renderer(() => parseFloat(getComputedStyle(document.querySelector('.settings-dialog')).borderRadius) > 0));
  const settingsFeedback = await renderer(() => {
    const el = document.querySelector('.settings-feedback');
    el.textContent = 'Synthetic settings diagnostic: ' + 'unbroken-error-'.repeat(100);
    const dialog = document.querySelector('.settings-dialog');
    const range = document.createRange(); range.selectNodeContents(el);
    return { overflow: el.scrollWidth - el.clientWidth, height: el.getBoundingClientRect().height,
      textInset:range.getBoundingClientRect().top - el.getBoundingClientRect().top,
      sidebarBottom:document.querySelector('.settings-sidebar').getBoundingClientRect().bottom,
      feedbackTop:el.getBoundingClientRect().top,
      padding: parseFloat(getComputedStyle(el).paddingBottom), dialogOverflow:dialog.scrollWidth - dialog.clientWidth };
  });
  assert.ok(settingsFeedback.overflow <= 1 && settingsFeedback.dialogOverflow <= 1 && settingsFeedback.height <= 120 && settingsFeedback.padding >= 10, JSON.stringify(settingsFeedback));
  assert.ok(settingsFeedback.textInset >= 10 && settingsFeedback.sidebarBottom <= settingsFeedback.feedbackTop, JSON.stringify(settingsFeedback));
  await screenshot('settings-long-error-en-1280x800');
  // Settings is a modal: close via its existing Escape handler.
  await evaluate(`${window}.webContents.sendInputEvent({type:'keyDown', keyCode:'ESC'}); undefined`);
  await delay(150);
  await navigate("sessions");
  const motion = await renderer(async () => {
    const parent = document.querySelector(".section-header");
    const child = parent.nextElementSibling;
    parent.focus();
    const openHeight = child.getBoundingClientRect().height;
    parent.click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const immediate = { expanded: parent.getAttribute("aria-expanded"), inert: child.inert, focus: document.activeElement === parent };
    await new Promise(resolve => setTimeout(resolve, 180));
    const closedHeight = child.getBoundingClientRect().height;
    parent.click();
    await new Promise(resolve => setTimeout(resolve, 220));
    return { immediate, openHeight, closedHeight, reopenedHeight: child.getBoundingClientRect().height,
      duration: getComputedStyle(child).transitionDuration };
  });
  assert.deepEqual(motion.immediate, { expanded: "false", inert: true, focus: true });
  assert.equal(motion.closedHeight, 0);
  assert.ok(motion.openHeight > 0 && motion.reopenedHeight > 0);
  await evaluate(`${window}.webContents.debugger.attach('1.3'); undefined`);
  try {
    await evaluate(`${window}.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]})`);
    const reduced = await renderer(() => ({ matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
      duration: getComputedStyle(document.querySelector('.session-disclosure')).transitionDuration }));
    assert.equal(reduced.matches, true);
    assert.equal(reduced.duration, "0s");
    motion.reduced = reduced;
  } finally { await evaluate(`${window}.webContents.debugger.detach(); undefined`); }
  const interactions = [];
  const pageNames = ['workbench', 'sessions', 'team-chat', 'runtimes', 'workflows', 'evaluation', 'memories', 'skills', 'mcp', 'providers'];
  for (const [width, height] of [[1728, 1000], [1000, 700], [860, 560]]) {
    await evaluate(`${window}.setContentSize(${width}, ${height}); undefined`);
    let reference;
    for (const page of pageNames) {
      await navigate(page);
      const readyDeadline = Date.now() + 10_000;
      while (!(await renderer(() => Boolean(document.querySelector('.app-page-head'))))) {
        if (Date.now() > readyDeadline) {
          await screenshot(`header-not-ready-${page}-${width}`);
          throw Error(`Page header did not become ready: ${page} at ${width}`);
        }
        await delay(200);
      }
      await fs.writeFile(path.join(outputRoot, 'ui-interaction-progress.json'), JSON.stringify({page, width, height, interactions}, null, 2));
      const header = await renderer(() => {
        const root = document.querySelector('.app-page-host').getBoundingClientRect();
        const head = document.querySelector('.app-page-head');
        const title = head.querySelector('h2');
        const description = head.querySelector('p');
        return { x: title.getBoundingClientRect().left - root.left, y: title.getBoundingClientRect().top - root.top,
          titleSize: getComputedStyle(title).fontSize, descriptionSize: getComputedStyle(description).fontSize,
          gap: description.getBoundingClientRect().top - title.getBoundingClientRect().bottom };
      });
      reference ??= header;
      assert.deepEqual(header, reference, JSON.stringify({page, width, header, reference}));
      interactions.push({page, width, height, header});
      if (page === 'workbench') {
        const readCards = () => [...document.querySelector('.workbench-overview').children].map(el => {
          const r = el.getBoundingClientRect(); return {left:r.left, width:r.width, height:r.height};
        });
        const beforeRefresh = await renderer(readCards);
        for (const selector of ['.workbench-usage-actions button', '.workbench-quota-card-head button']) {
          await renderer(selector => document.querySelector(selector).click(), selector);
          for (const pause of [50, 650, 1900]) {
            await delay(pause);
            const after = await renderer(readCards);
            after.forEach((card, i) => {
              for (const key of ['left', 'width', 'height']) assert.ok(Math.abs(card[key] - beforeRefresh[i][key]) <= 1,
                JSON.stringify({selector, width, pause, beforeRefresh, after}));
            });
            if (pause === 650) {
              const feedback = await renderer(() => {
                const el = document.querySelector('.workbench-feedback');
                const r = el.getBoundingClientRect();
                const parent = el.parentElement.getBoundingClientRect();
                return { text: el.textContent, inset: parent.bottom - r.bottom, background:getComputedStyle(el).backgroundColor,
                  position: getComputedStyle(el).position, overflow: el.scrollWidth - el.clientWidth };
              });
              assert.ok(feedback.text.length > 0 && feedback.inset > 0, JSON.stringify(feedback));
              assert.ok(feedback.overflow <= 1);
              interactions.push({page, width, selector, feedback, stableCards:after});
            }
          }
        }
        for (const days of [7, 30, 90]) {
          await renderer(days => {
            const select = document.querySelector('.workbench-token-trend-head select');
            select.value = String(days); select.dispatchEvent(new Event('change', {bubbles:true}));
          }, days);
          await delay(100);
          const trend = await renderer(() => ({
            points:document.querySelectorAll('.workbench-token-trend-point').length,
            markerOpacity:getComputedStyle(document.querySelector('.workbench-token-trend-point:not(.today):not(.is-active):not(:focus-visible) > span')).opacity,
            nonZeroPoints:[...document.querySelectorAll('.workbench-token-trend-point')].filter(el => !/(?:, |，)0 Token[.。]/.test(el.getAttribute('aria-label'))).length,
            labels:document.querySelectorAll('.workbench-token-trend-labels span').length,
            height:document.querySelector('.workbench-token-trend').getBoundingClientRect().height,
            plotHeight:document.querySelector('.workbench-token-trend-canvas').getBoundingClientRect().height,
            metricsPadding:parseFloat(getComputedStyle(document.querySelector('.usage-metrics')).paddingTop),
            divider:parseFloat(getComputedStyle(document.querySelector('.usage-metrics')).borderTopWidth),
            tabStops:document.querySelectorAll('.workbench-token-trend-point[tabindex="0"]').length,
          }));
          assert.equal(trend.points, days);
          assert.equal(trend.markerOpacity, days === 7 ? '1' : '0');
          assert.equal(trend.nonZeroPoints, days === 7 ? 1 : days === 30 ? 2 : 3);
          assert.equal(trend.labels, days === 7 ? 7 : 5);
          assert.ok(trend.plotHeight > 0);
          assert.ok(trend.metricsPadding > 0);
          assert.ok(trend.divider > 0 && trend.divider < trend.metricsPadding);
          assert.equal(trend.tabStops, 1);
          interactions.push({page, width, days, trend});
          await screenshot(`trend-${days}-days-${width}`);
          await navigate('sessions');
          assert.equal(await renderer(() => document.querySelector('.workbench-token-trend') === null), true);
          await navigate('workbench');
          const restoredTrend = await renderer(() => ({
            period: document.querySelector('.workbench-token-trend-head select').value,
            points: document.querySelectorAll('.workbench-token-trend-point').length,
            total: document.querySelector('.workbench-token-trend-head b').textContent,
          }));
          assert.equal(restoredTrend.period, String(days));
          assert.equal(restoredTrend.points, days);
          interactions.push({page, width, days, navigationRestored: restoredTrend});
        }
      }
      if (['runtimes', 'workflows', 'skills'].includes(page)) {
        await evaluate(`${electron}.app.focus({steal:true}); ${window}.focus(); ${window}.webContents.focus(); undefined`);
        await waitFor(() => document.hasFocus(), 'Split drag requires the isolated window to have native focus');
        const before = await renderer(() => Number(document.querySelector('.pane-resize-handle').getAttribute('aria-valuenow')));
        const point = await renderer(() => {
          const el = document.querySelector('.pane-resize-handle');
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(40, r.height / 2)) };
        });
        // Position the pointer before pressing, just as a physical drag does.
        await input({type:'mouseMove', ...point});
        await delay(70);
        for (const event of [{type:'mouseDown', ...point, button:'left', clickCount:1},
          {type:'mouseMove', x:point.x + 32, y:point.y, button:'left'},
          {type:'mouseUp', x:point.x + 32, y:point.y, button:'left', clickCount:1}]) {
          await input(event);
          await delay(70);
        }
        const dragged = await renderer(() => Number(document.querySelector('.pane-resize-handle').getAttribute('aria-valuenow')));
        assert.ok(dragged > before, JSON.stringify({page, width, before, dragged}));
        await renderer(() => document.querySelector('.pane-resize-handle').focus());
        await evaluate(`${window}.webContents.sendInputEvent({type:'keyDown', keyCode:'END'}); undefined`);
        await delay(100);
        const split = await renderer(() => {
          const el = document.querySelector('.pane-resize-handle');
          const parent = el.parentElement;
          return { value: Number(el.getAttribute('aria-valuenow')), max: Number(el.getAttribute('aria-valuemax')),
            overflow: parent.scrollWidth - parent.clientWidth, cursor: document.body.style.cursor };
        });
        assert.equal(split.value, split.max);
        assert.ok(split.overflow <= 1, JSON.stringify({page, width, split}));
        assert.notEqual(split.cursor, 'col-resize');
        if (page === 'runtimes') {
          const runtime = await renderer(() => {
            const rect = el => { const r = el.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}; };
            const balance = document.querySelector('.runtime-summary-balance');
            const actions = document.querySelector('.runtime-summary-actions');
            return { balance:rect(balance), actions:rect(actions), width:document.querySelector('.runtime-editor').getBoundingClientRect().width,
              overflow: [...document.querySelectorAll('.runtime-config-summary, .runtime-summary-balance, .runtime-summary-actions')].map(el => el.scrollWidth - el.clientWidth) };
          });
          assert.ok(runtime.width <= 1120);
          assert.ok(runtime.actions.top >= runtime.balance.bottom || runtime.actions.left >= runtime.balance.right, JSON.stringify(runtime));
          assert.ok(runtime.overflow.every(value => value <= 1), JSON.stringify(runtime));
          interactions.push({page, width, runtime});
        }
        await screenshot(`interaction-${page}-${width}x${height}`);
        // Return to the default width, then verify it survives page unmount/remount.
        await renderer(() => document.querySelector('.pane-resize-handle').dispatchEvent(new MouseEvent('dblclick', {bubbles:true})));
        const reset = await renderer(() => Number(document.querySelector('.pane-resize-handle').getAttribute('aria-valuenow')));
        await navigate('workbench');
        await navigate(page);
        assert.equal(await renderer(() => Number(document.querySelector('.pane-resize-handle').getAttribute('aria-valuenow'))), reset);
        interactions.push({page, width, before, dragged, split, reset});
      } else if (page === 'providers') {
        await renderer(() => [...document.querySelectorAll('.api-provider-switch button')].find(el => el.querySelector('strong')?.textContent === 'Custom').click());
        await delay(200);
        await renderer(() => document.querySelector('.codex-model-detect-button').click());
        await delay(700);
        // First verify a real local validation failure, then use the same CSS
        // in a synthetic fixture. React may refresh the live error while capturing.
        const error = await renderer(() => {
          const source = document.querySelector('.settings-field .api-config-status.error');
          const original = source.textContent;
          const el = source.cloneNode(true);
          el.dataset.syntheticDiagnostic = 'true';
          source.after(el);
          el.textContent = 'Synthetic diagnostic: ' + 'unbrokendetail'.repeat(60);
          const body = document.querySelector('.api-config-body');
          body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top - 80;
          const range = document.createRange(); range.selectNodeContents(el);
          const r = range.getBoundingClientRect();
          const parent = el.parentElement.getBoundingClientRect();
          return { original, overflow:el.scrollWidth - el.clientWidth, contained:r.left >= parent.left && r.right <= parent.right && r.bottom <= parent.bottom,
            span:getComputedStyle(el).gridColumn, presets:[...document.querySelectorAll('.api-provider-switch button')].map(button => ({width:button.getBoundingClientRect().width,
              height:button.getBoundingClientRect().height, paddingX:parseFloat(getComputedStyle(button).paddingLeft), paddingY:parseFloat(getComputedStyle(button).paddingTop)})) };
        });
        assert.ok(error.original.length > 0 && error.contained && error.overflow <= 1, JSON.stringify(error));
        assert.ok(error.presets.every(value => value.width >= 180 && value.height >= 44 && value.paddingX >= 12 && value.paddingY >= 8), JSON.stringify(error));
        interactions.push({page, width, error});
        await delay(100);
        await screenshot(`interaction-${page}-${width}x${height}`);
        await renderer(() => document.querySelector('[data-synthetic-diagnostic]')?.remove());
      } else if (page === 'workbench') await screenshot(`interaction-${page}-${width}x${height}`);
    }
  }
  try {
    await evaluate(`${window}.webContents.setZoomFactor(1.5); undefined`);
    for (const page of ['runtimes', 'workflows', 'skills']) {
      await navigate(page);
      const stacked = await renderer(() => {
        const split = document.querySelector('.resizable-split');
        const handle = split.querySelector('.pane-resize-handle');
        return {stacked:split.dataset.stacked, handleDisplay:getComputedStyle(handle).display,
          overflow:split.scrollWidth - split.clientWidth, tabIndex:handle.tabIndex};
      });
      assert.equal(stacked.stacked, 'true', JSON.stringify({page, stacked}));
      assert.equal(stacked.handleDisplay, 'none');
      assert.equal(stacked.tabIndex, -1);
      assert.ok(stacked.overflow <= 1, JSON.stringify({page, stacked}));
      interactions.push({page, width:860, zoom:1.5, stacked});
      await screenshot(`stacked-${page}-zoom-1.5`);
    }
  } finally { await evaluate(`${window}.webContents.setZoomFactor(1); undefined`); }
  const chartInput = [];
  await evaluate(`${window}.setContentSize(1280, 820); undefined`);
  const readChartFocus = () => {
    const buttons = [...document.querySelectorAll('.workbench-token-trend-point')];
    const canvas = document.querySelector('.workbench-token-trend-canvas');
    return { index: buttons.indexOf(document.activeElement), tabStops: buttons.filter(el => el.tabIndex === 0).length,
      dayStart: Number(document.activeElement?.dataset.dayStart), documentFocus: document.hasFocus(),
      focusVisible: document.activeElement?.matches(':focus-visible'),
      outlineWidth: parseFloat(getComputedStyle(canvas).outlineWidth), outlineStyle: getComputedStyle(canvas).outlineStyle };
  };
  const assertChartFocus = async index => {
    const focus = await renderer(readChartFocus);
    assert.equal(focus.index, index, JSON.stringify(focus));
    assert.equal(focus.tabStops, 1);
    assert.equal(focus.documentFocus, true, JSON.stringify(focus));
    assert.equal(focus.focusVisible, true, JSON.stringify(focus));
    assert.ok(focus.outlineWidth >= 2 && focus.outlineStyle === 'solid', JSON.stringify(focus));
    return focus;
  };
  const prepareChart = async days => {
    await evaluate(`${electron}.app.focus({steal:true}); ${window}.focus(); ${window}.webContents.focus(); undefined`);
    await waitFor(() => document.hasFocus(), 'Chart input requires the isolated window to have native focus');
    await navigate('workbench');
    await renderer(days => {
      document.querySelector('.workbench-page-content').scrollTop = 0;
      const select = document.querySelector('.workbench-token-trend-head select');
      select.value = String(days); select.dispatchEvent(new Event('change', { bubbles: true }));
    }, days);
    await waitFor(days => document.querySelectorAll('.workbench-token-trend-point').length === days, 'Trend range did not load', days);
    await renderer(() => {
      globalThis.__uiQualityChartClicks = 0;
      document.querySelector('.workbench-token-trend-canvas').addEventListener('click', () => { globalThis.__uiQualityChartClicks++; }, { capture: true });
      document.querySelector('.workbench-token-trend-head select').focus();
    });
    await press('Tab');
  };
  const assertSelectedSessionDay = async dayStart => {
    await waitFor(() => Boolean(document.querySelector('.sessions-page .date-filter-custom')), 'Trend activation did not open the Session date filter');
    const selection = await renderer(dayStart => ({
      expected: new Intl.DateTimeFormat(localStorage.getItem('agent-recall-language') === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric' }).format(dayStart),
      actual: document.querySelector('.date-filter-custom span').textContent,
      nativeClicks: globalThis.__uiQualityChartClicks,
      chartClosed: document.querySelector('.workbench-token-trend') === null,
    }), dayStart);
    assert.equal(selection.actual, selection.expected);
    assert.equal(selection.nativeClicks, 1);
    assert.equal(selection.chartClosed, true);
    await renderer(() => document.querySelector('.date-filter-custom').click());
    return selection;
  };
  for (const days of [7, 30, 90]) {
    await prepareChart(days);
    const navigation = [await assertChartFocus(days - 1)];
    for (const [key, index] of [['Right', days - 1], ['Left', days - 2], ['Right', days - 1], ['Home', 0], ['Left', 0], ['Right', 1], ['End', days - 1]]) {
      await press(key);
      navigation.push({ key, ...await assertChartFocus(index) });
    }
    await screenshot(`trend-keyboard-focus-${days}`);
    const enterDay = navigation.at(-1).dayStart;
    await press('Enter');
    const enter = await assertSelectedSessionDay(enterDay);
    await prepareChart(days);
    await press('Home');
    const spaceDay = (await assertChartFocus(0)).dayStart;
    await press('Space');
    const space = await assertSelectedSessionDay(spaceDay);
    await prepareChart(days);
    const pointer = await renderer(() => {
      const buttons = [...document.querySelectorAll('.workbench-token-trend-point')];
      const index = Math.floor(buttons.length / 2);
      const r = document.querySelector('.workbench-token-trend-canvas').getBoundingClientRect();
      // Offset from the marker's x and use the bottom of the plot rather than
      // its y: selecting a date must not require a precise marker hit.
      return { x: Math.round(r.left + r.width * (10 + (index + .15) / (buttons.length - 1) * 260) / 280),
        y: Math.round(r.bottom - 4), dayStart: Number(buttons[index].dataset.dayStart), index };
    });
    await input({ type: 'mouseMove', x: pointer.x, y: pointer.y });
    await input({ type: 'mouseDown', x: pointer.x, y: pointer.y, button: 'left', clickCount: 1 });
    await input({ type: 'mouseUp', x: pointer.x, y: pointer.y, button: 'left', clickCount: 1 });
    const selectedPointer = await assertSelectedSessionDay(pointer.dayStart);
    chartInput.push({ days, navigation, enter, space, pointer: { ...pointer, ...selectedPointer } });
  }
  await navigate('workbench');
  await evaluate(`${window}.webContents.debugger.attach('1.3'); undefined`);
  let chartReducedMotion;
  try {
    await evaluate(`${window}.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]})`);
    await renderer(() => document.querySelector('.workbench-token-trend-head select').focus());
    await press('Tab');
    await press('Left');
    chartReducedMotion = await renderer(() => {
      const chart = document.querySelector('.workbench-token-trend');
      return { matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
        transitionDurations: getComputedStyle(chart).transitionDuration.split(',').map(value => parseFloat(value)),
        runningAnimations: chart.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running' && Number(animation.effect.getComputedTiming().duration) > 1).length };
    });
    assert.equal(chartReducedMotion.matches, true);
    assert.ok(chartReducedMotion.transitionDurations.every(value => value === 0));
    assert.equal(chartReducedMotion.runningAnimations, 0);
    await screenshot('trend-reduced-motion');
  } finally {
    await evaluate(`${window}.webContents.debugger.detach(); undefined`);
    await renderer(() => { delete globalThis.__uiQualityChartClicks; });
  }
  await fs.writeFile(path.join(outputRoot, "ui-quality-result.json"), JSON.stringify({ results, extendedMatrix,
    zoomResults, otherPages, motion, interactions, settingsFeedback, chartInput, chartReducedMotion, screenshotCount }, null, 2));
  return { sizes, languages: ['zh', 'en'], screenshotCount, motion, chartReducedMotion, resultFile: path.join(outputRoot, "ui-quality-result.json") };
}
