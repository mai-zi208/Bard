(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const state = {
    packs: [],
    id: null,
    content: null,
    index: 0,
    media: { cover: null, scenes: [] },
    published: false,
    check: null,
    dirty: false,
    mediaStale: false,
    busy: false
  };

  /* ---------- 基础工具 ---------- */

  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escAttr(text) {
    return esc(text);
  }

  function pick(value, lang) {
    const locale = lang || 'zh-CN';
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map((item) => String(item)).join('');
    if (typeof value === 'object') {
      if (value[locale] !== undefined) return String(value[locale]);
      const key = Object.keys(value)[0];
      return key ? String(value[key]) : '';
    }
    return '';
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function div(className, children) {
    const node = document.createElement('div');
    if (className) node.className = className;
    (children || []).forEach((child) => node.appendChild(child));
    return node;
  }

  function span(className, text) {
    const node = document.createElement('span');
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, onClick, className) {
    const node = document.createElement('button');
    node.type = 'button';
    if (className) node.className = className;
    node.textContent = text;
    node.addEventListener('click', onClick);
    return node;
  }

  function field(labelText, control, hintText) {
    const wrap = div('field');
    const label = document.createElement('label');
    label.textContent = labelText;
    wrap.appendChild(label);
    wrap.appendChild(control);
    if (hintText) {
      const hint = div('hint');
      hint.textContent = hintText;
      wrap.appendChild(hint);
    }
    return wrap;
  }

  function textInput(value, onInput, attrs) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value == null ? '' : String(value);
    if (attrs) Object.keys(attrs).forEach((key) => input.setAttribute(key, attrs[key]));
    input.addEventListener('input', () => onInput(input.value));
    return input;
  }

  function textArea(value, rows, onInput) {
    const area = document.createElement('textarea');
    area.rows = rows || 4;
    area.value = value == null ? '' : String(value);
    area.addEventListener('input', () => onInput(area.value));
    return area;
  }

  function selectInput(options, value, onChange) {
    const select = document.createElement('select');
    options.forEach((item) => {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      select.appendChild(option);
    });
    select.value = value == null ? '' : String(value);
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  function currentScene() {
    if (!state.content || !Array.isArray(state.content.scenes)) return null;
    return state.content.scenes[state.index] || null;
  }

  function isV2(scene) {
    return Boolean(scene && typeof scene.body === 'string' && scene.body.trim());
  }

  function toast(message, fail) {
    const node = $('#toast');
    node.textContent = message;
    node.className = 'toast' + (fail ? ' fail' : '');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      node.className = 'toast hidden';
    }, 3200);
  }

  async function request(url, options) {
    try {
      const res = await fetch(url, options);
      let data = {};
      try {
        data = await res.json();
      } catch {
        data = { message: '响应不是 JSON（' + res.status + '）' };
      }
      return { status: res.status, data };
    } catch (err) {
      return { status: 0, data: { message: '请求失败：' + (err.message || err) } };
    }
  }

  function jsonOptions(method, payload) {
    return {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    };
  }

  /* ---------- 状态与顶栏 ---------- */

  function markDirty() {
    state.dirty = true;
    state.check = null;
    renderStatus();
    updateTopbar();
  }

  function setBusy(busy) {
    state.busy = busy;
    updateTopbar();
  }

  function updateTopbar() {
    const flag = $('#dirty-flag');
    flag.textContent = state.busy ? '处理中…' : state.dirty ? '有未保存改动' : '未改动';
    flag.className = 'dirty-flag' + (state.dirty ? ' dirty' : '');

    $('#btn-save').disabled = state.busy || !state.content || !state.dirty;
    $('#btn-check').disabled = state.busy || !state.content;
    $('#btn-publish').disabled =
      state.busy || !state.content || !state.check || !state.check.ok || state.dirty;

    const pack = state.packs.find((item) => item.id === state.id);
    const meta = $('#pack-meta');
    if (!state.content) {
      meta.textContent = '';
      return;
    }
    const version = state.content.scenes && state.content.scenes.some(isV2) ? 2 : 1;
    const parts = [
      (state.content.scenes || []).length + ' 幕',
      'schemaVersion ' + version,
      state.published ? '已发布' : '未发布'
    ];
    if (state.content.generated) parts.push('生成包');
    if (state.content.persona) parts.push('人物：' + state.content.persona);
    if (pack && pack.broken) parts.push('content.json 解析失败');
    meta.textContent = parts.join(' · ');
  }

  /* ---------- 分镜列表 ---------- */

  function renderSceneList() {
    const list = $('#scene-list');
    list.innerHTML = '';
    const scenes = (state.content && state.content.scenes) || [];
    $('#scene-count').textContent = scenes.length + ' 幕';

    scenes.forEach((scene, index) => {
      const li = document.createElement('li');
      if (index === state.index) li.className = 'active';
      li.addEventListener('click', () => {
        if (state.index === index) return;
        state.index = index;
        renderSceneList();
        renderEditor();
        renderPreview();
      });

      li.appendChild(span('num', pad2(index + 1)));
      li.appendChild(span('name', pick(scene.title) || scene.id || '未命名'));
      if (isV2(scene)) li.appendChild(span('badge v2', 'v2'));

      const move = div('move');
      const up = button('↑', () => moveScene(index, -1));
      up.disabled = index === 0;
      const down = button('↓', () => moveScene(index, 1));
      down.disabled = index === scenes.length - 1;
      move.appendChild(up);
      move.appendChild(down);
      li.appendChild(move);
      list.appendChild(li);
    });
  }

  function moveScene(index, delta) {
    const scenes = state.content.scenes;
    const target = index + delta;
    if (target < 0 || target >= scenes.length) return;
    const item = scenes.splice(index, 1)[0];
    scenes.splice(target, 0, item);
    state.index = target;
    state.mediaStale = true;
    markDirty();
    renderSceneList();
    renderEditor();
    renderPreview();
  }

  /* ---------- 编辑区 ---------- */

  function renderEditor() {
    const host = $('#editor');
    host.innerHTML = '';
    const scene = currentScene();
    if (!scene) {
      host.appendChild(div('tip-box', []));
      host.firstChild.textContent = '左侧没有可编辑的分镜。';
      return;
    }

    // 只读标识
    const readonly = div('readonly');
    readonly.innerHTML =
      'scene.id：' +
      esc(scene.id) +
      ' · 人物插画：' +
      (scene.portrait ? '有' : state.content.narrator ? '无（走讲述人立绘）' : '无');
    host.appendChild(readonly);

    const row1 = div('form-row');
    row1.appendChild(
      field(
        '标题（≤12 字）',
        textInput(pick(scene.title), (value) => {
          setSceneText(scene, 'title', value);
          renderSceneList();
          renderPreview();
        }, { maxlength: 12 })
      )
    );
    row1.appendChild(
      field(
        '副标题（≤20 字）',
        textInput(pick(scene.subtitle), (value) => {
          setSceneText(scene, 'subtitle', value);
          renderPreview();
        }, { maxlength: 20 })
      )
    );
    host.appendChild(row1);

    const row2 = div('form-row');
    row2.appendChild(
      field(
        '图片说明 imageAlt（≤40 字）',
        textInput(pick(scene.imageAlt), (value) => setSceneText(scene, 'imageAlt', value), {
          maxlength: 40
        })
      )
    );
    host.appendChild(row2);

    const row3 = div('form-row');
    row3.appendChild(
      field(
        '切幕动效',
        selectInput(
          [
            { value: '', label: '默认（zoom-out）' },
            { value: 'zoom-out', label: 'zoom-out' },
            { value: 'rise', label: 'rise' },
            { value: 'slide', label: 'slide' },
            { value: 'fade', label: 'fade' }
          ],
          scene.transition || '',
          (value) => setSceneValue(scene, 'transition', value)
        )
      )
    );
    row3.appendChild(
      field(
        '停留时长 holdMs',
        textInput(scene.holdMs == null ? '' : String(scene.holdMs), (value) => {
          const num = value.trim() === '' ? null : Number(value);
          setSceneValue(scene, 'holdMs', num && Number.isFinite(num) ? num : '');
        }, { type: 'number', min: '2000', max: '15000', step: '500' })
      )
    );
    row3.appendChild(
      field(
        '版式 layout',
        selectInput(
          [
            { value: '', label: '默认（side）' },
            { value: 'side', label: 'side（立绘 + 文字）' },
            { value: 'full', label: 'full（通宽无立绘）' }
          ],
          scene.layout || '',
          (value) => setSceneValue(scene, 'layout', value)
        )
      )
    );
    host.appendChild(row3);

    host.appendChild(bodySection(scene));
    host.appendChild(narrationSection(scene));
  }

  function setSceneText(scene, key, value) {
    if (value === '') delete scene[key];
    else scene[key] = value;
    markDirty();
  }

  function setSceneValue(scene, key, value) {
    if (value === '' || value == null) delete scene[key];
    else scene[key] = value;
    markDirty();
  }

  function plainChars(md) {
    return String(md || '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^>\s?/gm, '')
      .replace(/^[-*]\s+/gm, '')
      .replace(/\*\*/g, '')
      .replace(/\s+/g, '').length;
  }

  function bodySection(scene) {
    const section = div('section');
    const head = div('section-head');
    const title = document.createElement('strong');
    title.textContent = '正文';
    head.appendChild(title);
    head.appendChild(span('muted', isV2(scene) ? 'v2 · 单页 Markdown' : 'v1 · 分屏'));
    section.appendChild(head);

    if (typeof scene.body === 'string') {
      const counter = div('counter');
      const area = textArea(scene.body, 18, (value) => {
        scene.body = value;
        counter.textContent = 'Markdown · 约 ' + plainChars(value) + ' 字（单幕上限 20000 字）';
        markDirty();
        renderPreview();
      });
      section.appendChild(area);
      counter.textContent = 'Markdown · 约 ' + plainChars(scene.body) + ' 字（单幕上限 20000 字）';
      section.appendChild(counter);

      const hint = div('tip-box');
      hint.innerHTML =
        '支持标题、段落、图片 <code>![说明](imgs/x.jpg)</code>、引用、无序列表、加粗、分隔线；' +
        '图片用相对路径，装配后落成 <code>body/{序号}-{id}.md</code>。清空正文会阻断校验。';
      section.appendChild(hint);
      return section;
    }

    if (Array.isArray(scene.pages)) {
      section.appendChild(pagesEditor(scene));
      return section;
    }

    if (Array.isArray(scene.paragraphs)) {
      const card = div('page-card');
      scene.paragraphs.forEach((text, index) => {
        const row = div('block-row');
        row.appendChild(
          textArea(text, 2, (value) => {
            scene.paragraphs[index] = value;
            markDirty();
            renderPreview();
          })
        );
        card.appendChild(row);
      });
      section.appendChild(card);
      const hint = div('tip-box');
      hint.textContent = '本包使用旧的 paragraphs 结构；装配时仍按 v1 渲染。';
      section.appendChild(hint);
      return section;
    }

    const empty = div('tip-box');
    empty.textContent = '本幕既没有 body（v2）也没有 pages / paragraphs（v1），补正文后才能通过校验。';
    section.appendChild(empty);
    return section;
  }

  function pagesEditor(scene) {
    const wrap = div('');

    scene.pages.forEach((page, pageIndex) => {
      const card = div('page-card');
      const head = div('page-head');
      head.appendChild(span('', '第 ' + (pageIndex + 1) + ' 页'));

      const right = div('right');
      right.appendChild(
        button('+ 块', () => {
          page.push('');
          markDirty();
          renderEditor();
        })
      );
      right.appendChild(
        button('删除页', () => {
          if (scene.pages.length <= 1) return;
          scene.pages.splice(pageIndex, 1);
          markDirty();
          renderEditor();
          renderPreview();
        })
      );
      head.appendChild(right);
      card.appendChild(head);

      page.forEach((block, blockIndex) => {
        const row = div('block-row');
        row.appendChild(
          textArea(block, 3, (value) => {
            page[blockIndex] = value;
            markDirty();
            renderPreview();
          })
        );
        row.appendChild(
          button('删块', () => {
            page.splice(blockIndex, 1);
            if (!page.length) page.push('');
            markDirty();
            renderEditor();
            renderPreview();
          })
        );
        card.appendChild(row);
      });

      wrap.appendChild(card);
    });

    wrap.appendChild(
      button('+ 添加一页', () => {
        scene.pages.push(['']);
        markDirty();
        renderEditor();
        renderPreview();
      })
    );

    const hint = div('tip-box');
    hint.textContent =
      '分屏结构：每页 1–2 块、单块 ≤60 字，校验会对超长与空块给出提示。' +
      '与 v2 单页 Markdown 互斥，装配时按页渲染。';
    wrap.appendChild(hint);
    return wrap;
  }

  function narrationSection(scene) {
    const section = div('section');
    const head = div('section-head');
    const title = document.createElement('strong');
    title.textContent = '口播稿';
    head.appendChild(title);
    head.appendChild(span('muted', '旧字段，仅保留历史文本；不再参与渲染'));
    section.appendChild(head);

    const area = textArea(scene.narration || '', 7, (value) => {
      if (value.trim() === '') delete scene.narration;
      else scene.narration = value;
      markDirty();
    });
    section.appendChild(area);
    return section;
  }

  /* ---------- 预览 ---------- */

  function renderPreview() {
    const phone = $('#phone');
    const scene = currentScene();
    if (!scene) {
      phone.innerHTML = '';
      $('#preview-note').textContent = '';
      return;
    }

    const media = state.media.scenes[state.index] || {};
    const image = media.image && media.image.variant !== 'missing' ? media.image.url : '';
    const portrait = media.portrait && media.portrait.variant !== 'missing' ? media.portrait.url : '';
    const total = (state.content.scenes || []).length;

    phone.innerHTML =
      '<div class="ph-image' +
      (image ? '' : ' missing') +
      '"' +
      (image ? ' style="background-image:url(\'' + escAttr(image) + '\')"' : '') +
      '></div>' +
      '<div class="ph-scrim"></div>' +
      '<div class="ph-content">' +
      '<div class="ph-index">' +
      pad2(state.index + 1) +
      ' / ' +
      pad2(total) +
      '</div>' +
      '<div class="ph-title">' +
      esc(pick(scene.title) || scene.id) +
      '</div>' +
      (pick(scene.subtitle) ? '<div class="ph-subtitle">' + esc(pick(scene.subtitle)) + '</div>' : '') +
      '<div class="ph-body">' +
      bodyHtml(scene) +
      '</div>' +
      '</div>' +
      (portrait ? '<img class="ph-portrait" src="' + escAttr(portrait) + '" alt="讲述人">' : '') +
      '<div class="ph-foot">' +
      '<button class="ph-audio" disabled>▶ 收听讲解</button>' +
      '</div>';

    const notes = [];
    if (state.mediaStale) notes.push('分镜顺序已调整，图片文件名随序号变化，请重新校验刷新预览。');
    notes.push('预览按已发布 / 本次校验的素材渲染，最终以装配结果为准。');
    $('#preview-note').textContent = notes.join(' ');
  }

  function bodyHtml(scene) {
    if (typeof scene.body === 'string') {
      const html = renderMarkdown(scene.body, state.id);
      return html || '<p>（本幕正文为空）</p>';
    }
    if (Array.isArray(scene.pages) && scene.pages.length) {
      return (scene.pages[0] || []).map((block) => '<p>' + esc(block) + '</p>').join('');
    }
    if (Array.isArray(scene.paragraphs) && scene.paragraphs.length) {
      return scene.paragraphs.map((block) => '<p>' + esc(block) + '</p>').join('');
    }
    return '<p>（本幕还没有正文）</p>';
  }

  function inlineText(text) {
    return esc(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  function imageSrc(src, packId) {
    if (/^https?:\/\//i.test(src) || src.charAt(0) === '/') return src;
    return '/media/pub/' + encodeURIComponent(packId) + '/' + encodeURI(src);
  }

  /** 预览用 Markdown 子集：标题、段落、图片、引用、列表、加粗、分隔线 */
  function renderMarkdown(md, packId) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let paragraph = [];
    let list = [];

    const flushParagraph = () => {
      if (!paragraph.length) return;
      out.push('<p>' + inlineText(paragraph.join(' ')) + '</p>');
      paragraph = [];
    };
    const flushList = () => {
      if (!list.length) return;
      out.push('<ul>' + list.map((item) => '<li>' + inlineText(item) + '</li>').join('') + '</ul>');
      list = [];
    };

    lines.forEach((raw) => {
      const line = raw.trim();
      if (!line) {
        flushParagraph();
        flushList();
        return;
      }
      let match;
      if ((match = /^(#{1,6})\s+(.*)$/.exec(line))) {
        flushParagraph();
        flushList();
        const level = Math.min(match[1].length + 2, 5);
        out.push('<h' + level + '>' + inlineText(match[2]) + '</h' + level + '>');
        return;
      }
      if ((match = /^>\s?(.*)$/.exec(line))) {
        flushParagraph();
        flushList();
        out.push('<blockquote>' + inlineText(match[1]) + '</blockquote>');
        return;
      }
      if ((match = /^[-*]\s+(.*)$/.exec(line))) {
        flushParagraph();
        list.push(match[1]);
        return;
      }
      if (/^-{3,}$/.test(line)) {
        flushParagraph();
        flushList();
        out.push('<hr>');
        return;
      }
      if ((match = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(line))) {
        flushParagraph();
        flushList();
        out.push(
          '<img alt="' +
            esc(match[1]) +
            '" src="' +
            escAttr(imageSrc(match[2], packId)) +
            '" onerror="this.style.display=\'none\'">'
        );
        return;
      }
      flushList();
      paragraph.push(line);
    });

    flushParagraph();
    flushList();
    return out.join('');
  }

  /* ---------- 校验状态 ---------- */

  function timeText(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('zh-CN', { hour12: false });
  }

  function stripPrefix(line) {
    return String(line).replace(/^\[(错误|警告)\]\s*/, '');
  }

  function renderStatus() {
    const host = $('#status');
    if (!state.check) {
      host.className = 'status hidden';
      host.innerHTML = '';
      return;
    }
    const errors = state.check.errors || [];
    const warnings = state.check.warnings || [];
    host.className = 'status ' + (state.check.ok ? 'ok' : 'fail');
    host.innerHTML =
      '<div class="status-head">' +
      (state.check.ok ? '✔ 校验通过' : '✘ 校验未通过') +
      ' · ' +
      errors.length +
      ' 错误 / ' +
      warnings.length +
      ' 警告 · ' +
      esc(timeText(state.check.at)) +
      '</div>' +
      (errors.length
        ? '<ul>' +
          errors.map((line) => '<li class="error">' + esc(stripPrefix(line)) + '</li>').join('') +
          '</ul>'
        : '') +
      (warnings.length
        ? '<details' +
          (errors.length ? '' : ' open') +
          '><summary class="warn">' +
          warnings.length +
          ' 条警告</summary><ul>' +
          warnings.map((line) => '<li class="warn">' + esc(stripPrefix(line)) + '</li>').join('') +
          '</ul></details>'
        : '');
  }

  function showStatusLoading(text) {
    const host = $('#status');
    host.className = 'status';
    host.innerHTML = '<div class="status-head">' + esc(text) + '</div>';
  }

  /* ---------- 读取 / 保存 / 校验 / 发布 ---------- */

  async function loadPack(id) {
    const { status, data } = await request('/api/packs/' + encodeURIComponent(id));
    if (status !== 200) {
      toast(data.message || '读取资源包失败', true);
      return;
    }
    state.id = id;
    state.content = data.content;
    state.media = data.media || { scenes: [] };
    state.published = Boolean(data.published);
    state.check = data.check || null;
    state.index = 0;
    state.dirty = false;
    state.mediaStale = false;

    $('#pack-select').value = id;
    renderSceneList();
    renderEditor();
    renderPreview();
    renderStatus();
    updateTopbar();
  }

  async function saveContent() {
    if (!state.content || state.busy) return false;
    setBusy(true);
    const { status, data } = await request(
      '/api/packs/' + encodeURIComponent(state.id),
      jsonOptions('PUT', { content: state.content })
    );
    setBusy(false);
    if (status !== 200) {
      toast(data.message || '保存失败', true);
      return false;
    }
    state.dirty = false;
    updateTopbar();
    toast('已保存 content.json');
    return true;
  }

  async function runCheck() {
    if (!state.content || state.busy) return;
    setBusy(true);
    showStatusLoading('校验中：装配 + 转图 + 校验，可能需要十几秒…');
    const { status, data } = await request(
      '/api/packs/' + encodeURIComponent(state.id) + '/check',
      jsonOptions('POST', { content: state.content })
    );
    setBusy(false);

    if (status !== 200 && status !== 422) {
      state.check = null;
      renderStatus();
      toast(data.message || '校验请求失败', true);
      updateTopbar();
      return;
    }

    state.check = {
      ok: Boolean(data.ok),
      errors: data.errors || [],
      warnings: data.warnings || [],
      at: data.at
    };
    state.media = data.media || state.media;
    state.mediaStale = false;
    state.dirty = false;
    renderStatus();
    renderSceneList();
    renderPreview();
    updateTopbar();
    toast(data.ok ? '校验通过，可以发布' : '校验未通过，按提示修改后再发布', !data.ok);
  }

  async function runPublish() {
    if (!state.content || state.busy) return;
    const confirmed = window.confirm(
      '发布将覆盖 cdn/' +
        state.id +
        '/（旧版保留在 cdn/.backup/），并重建 manifest.json。继续？'
    );
    if (!confirmed) return;

    setBusy(true);
    showStatusLoading('发布中：校验 → 换入 cdn/' + state.id + ' → 重建清单…');
    const { status, data } = await request(
      '/api/packs/' + encodeURIComponent(state.id) + '/publish',
      jsonOptions('POST', { content: state.content })
    );
    setBusy(false);

    if (status !== 200 && status !== 422) {
      renderStatus();
      toast(data.message || '发布请求失败', true);
      updateTopbar();
      return;
    }

    state.check = {
      ok: Boolean(data.ok),
      errors: data.errors || [],
      warnings: data.warnings || [],
      at: data.at
    };
    if (data.ok) {
      state.dirty = false;
      state.mediaStale = false;
      state.media = data.media || state.media;
      await refreshSideInfo();
    }
    renderStatus();
    updateTopbar();
    toast(
      data.ok
        ? '已发布到 cdn/' + state.id + (data.manifestOk === false ? '，但清单重建失败' : '')
        : '发布被拦截：校验未通过',
      !data.ok
    );
  }

  /** 发布后只刷新素材状态，不重置当前分镜 */
  async function refreshSideInfo() {
    const { status, data } = await request('/api/packs/' + encodeURIComponent(state.id));
    if (status !== 200) return;
    state.media = data.media || state.media;
    state.published = Boolean(data.published);
    renderSceneList();
    renderPreview();
    updateTopbar();
  }

  /* ---------- 包设置抽屉 ---------- */

  function openDrawer() {
    const content = state.content;
    if (!content) return;
    const body = $('#drawer-body');
    body.innerHTML = '';

    const version = (content.scenes || []).some(isV2) ? 2 : 1;
    const info = div('readonly');
    info.innerHTML =
      'id：' +
      esc(content.id) +
      '<br>version：' +
      esc(content.version == null ? 1 : content.version) +
      '<br>schemaVersion：' +
      version +
      '<br>幕数：' +
      (content.scenes || []).length +
      (content.masterId ? '<br>母本：' + esc(content.masterId) : '') +
      (content.persona ? '<br>讲述人身份：' + esc(content.persona) : '') +
      '<br>来源：' +
      (content.generated ? '生成包（AI 生成）' : '手工包');
    body.appendChild(info);

    const section = div('section');
    const row1 = div('form-row');
    row1.appendChild(
      field(
        '标题（≤20 字）',
        textInput(pick(content.title), (value) => setContentText('title', value), { maxlength: 20 })
      )
    );
    row1.appendChild(
      field(
        '副标题（≤30 字）',
        textInput(pick(content.subtitle), (value) => setContentText('subtitle', value), {
          maxlength: 30
        })
      )
    );
    section.appendChild(row1);

    const row2 = div('form-row');
    row2.appendChild(
      field(
        '摘要（≤60 字）',
        textInput(pick(content.summary), (value) => setContentText('summary', value), {
          maxlength: 60
        })
      )
    );
    section.appendChild(row2);

    const row3 = div('form-row');
    row3.appendChild(
      field(
        '作者（≤20 字）',
        textInput(pick(content.author), (value) => setContentText('author', value), {
          maxlength: 20
        })
      )
    );
    row3.appendChild(
      field(
        '标签（逗号分隔，≤5 个）',
        textInput((content.tags || []).join('，'), (value) => {
          const tags = value
            .split(/[，,、\s]+/)
            .map((item) => item.trim())
            .filter(Boolean)
            .slice(0, 5);
          if (tags.length) content.tags = tags;
          else delete content.tags;
          markDirty();
        })
      )
    );
    section.appendChild(row3);

    const theme = content.theme || {};
    const row4 = div('form-row');
    row4.appendChild(field('背景色 bg', colorInput(theme.bg || '#16130F', (value) => setTheme('bg', value))));
    row4.appendChild(field('正文色 text', colorInput(theme.text || '#F2EBDD', (value) => setTheme('text', value))));
    row4.appendChild(field('强调色 accent', colorInput(theme.accent || '#C9A227', (value) => setTheme('accent', value))));
    section.appendChild(row4);

    const row5 = div('form-row');
    row5.appendChild(
      field(
        '保鲜天数 ttlDays（可选）',
        textInput(content.ttlDays == null ? '' : String(content.ttlDays), (value) => {
          const num = Number(value);
          if (value.trim() === '' || !Number.isFinite(num) || num <= 0) delete content.ttlDays;
          else content.ttlDays = Math.round(num);
          markDirty();
        }, { type: 'number', min: '1' })
      )
    );
    section.appendChild(row5);

    const narratorBox = div('tip-box');
    if (content.narrator && typeof content.narrator === 'object') {
      narratorBox.innerHTML =
        '讲述人：' +
        esc(pick(content.narrator.name)) +
        (content.narrator.title ? '（' + esc(pick(content.narrator.title)) + '）' : '') +
        ' · id ' +
        esc(content.narrator.id) +
        '<br>讲述人名称与身份由生成端写入，避免与立绘、音色不一致，这里只读。';
    } else {
      narratorBox.textContent = '本包没有讲述人，按「现代导游」渲染：不显示立绘，音频用中性音色。';
    }
    section.appendChild(narratorBox);

    body.appendChild(section);
    $('#drawer').classList.remove('hidden');
  }

  function colorInput(value, onChange) {
    const input = document.createElement('input');
    input.type = 'color';
    input.value = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#16130F';
    input.addEventListener('input', () => onChange(input.value));
    return input;
  }

  function setTheme(key, value) {
    const content = state.content;
    content.theme = content.theme && typeof content.theme === 'object' ? content.theme : {};
    content.theme[key] = value;
    markDirty();
    renderPreview();
  }

  function setContentText(key, value) {
    const content = state.content;
    if (value === '') delete content[key];
    else content[key] = value;
    markDirty();
    updateTopbar();
    if (key === 'title') {
      // 顶栏选择项同步显示新标题
      const option = $('#pack-select').selectedOptions[0];
      if (option) option.textContent = value + '（' + state.id + '）' + (state.published ? '' : ' · 未发布');
    }
  }

  function closeDrawer() {
    $('#drawer').classList.add('hidden');
  }

  /* ---------- 初始化 ---------- */

  function bindGlobal() {
    $('#btn-save').addEventListener('click', saveContent);
    $('#btn-check').addEventListener('click', runCheck);
    $('#btn-publish').addEventListener('click', runPublish);
    $('#btn-settings').addEventListener('click', openDrawer);
    $('#btn-close-drawer').addEventListener('click', closeDrawer);
    $('#drawer').addEventListener('click', (event) => {
      if (event.target.id === 'drawer') closeDrawer();
    });
    document.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault();
        saveContent();
      }
    });
  }

  async function init() {
    bindGlobal();
    const { status, data } = await request('/api/packs');
    if (status !== 200) {
      toast(data.message || '读取资源包列表失败', true);
      return;
    }
    state.packs = Array.isArray(data) ? data : [];
    const select = $('#pack-select');
    select.innerHTML = '';
    state.packs.forEach((pack) => {
      const option = document.createElement('option');
      option.value = pack.id;
      option.textContent =
        (pack.title || pack.id) + '（' + pack.id + '）' + (pack.published ? '' : ' · 未发布');
      select.appendChild(option);
    });
    select.addEventListener('change', () => {
      if (state.dirty && !window.confirm('当前包有未保存的改动，切换后会丢失。继续？')) {
        select.value = state.id;
        return;
      }
      loadPack(select.value);
    });

    if (!state.packs.length) {
      $('#editor').innerHTML =
        '<div class="tip-box">packs-src 下没有可编辑的资源包。生成一个包后再打开编辑器。</div>';
      updateTopbar();
      return;
    }
    await loadPack(state.packs[0].id);
  }

  init();
})();
