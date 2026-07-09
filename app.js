/* ============================================================
   UniTube — app.js
   Single-file-style logic (no bundler) for a 240x320 D-pad phone.
   Data model:
     Channel { id, name, urls:[ {id,title,url} ... ] }
       - 1 url  -> "live/direct" channel, tapping plays immediately
       - 2+ urls -> "list" channel, tapping shows an episode list
   Storage: localStorage key "unitube.channels.v1"
   ============================================================ */

(function () {
  "use strict";

  // ---------------------------------------------------------------
  // Defaults (placeholder demo streams — replace via Add screen)
  // ---------------------------------------------------------------
  var DEFAULT_CHANNELS = [
    {
      id: "demo-live",
      name: "Demo Live Feed",
      urls: [
        { id: "u1", title: "Demo Live Feed", url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8" }
      ]
    },
    {
      id: "demo-series",
      name: "Demo Series",
      urls: [
        { id: "u1", title: "Episode 1 — Big Buck Bunny", url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8" },
        { id: "u2", title: "Episode 2 — Sintel", url: "https://test-streams.mux.dev/x36xhzz/url_0/193039199_mp4_h264_aac_hd_7.m3u8" }
      ]
    }
  ];

  var STORE_KEY = "unitube.channels.v1";

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------
  var state = {
    channels: [],
    tab: "home",           // home | channels | add
    view: "list",          // list | channelDetail | player | form
    focusIndex: 0,
    activeChannel: null,    // channel object when in channelDetail
    hls: null,
    hudTimer: null,
    formFields: [],         // for add form nav
    formFocus: 0,
    formData: {}
  };

  // ---------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------
  function loadChannels() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) return parsed;
      }
    } catch (e) {}
    return JSON.parse(JSON.stringify(DEFAULT_CHANNELS));
  }

  function saveChannels() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state.channels));
    } catch (e) {
      toast("Storage full — could not save", true);
    }
  }

  function uid() {
    return Math.random().toString(36).slice(2, 9);
  }

  // ---------------------------------------------------------------
  // M3U / M3U8 channel-list parser
  // Handles standard #EXTM3U + #EXTINF:duration,Title \n URL blocks,
  // and bare URL-per-line lists (no EXTINF) as a fallback.
  // baseUrl (optional) is used to resolve relative entries.
  // ---------------------------------------------------------------
  function parseM3U(text, baseUrl) {
    var lines = text.split(/\r?\n/);
    var items = [];
    var pendingTitle = null;

    function resolve(u) {
      u = u.trim();
      if (!u) return null;
      if (/^https?:\/\//i.test(u)) return u;
      if (baseUrl) {
        try { return new URL(u, baseUrl).href; } catch (e) { /* fall through */ }
      }
      return u; // leave as-is; will fail URL validation later if unusable
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.indexOf("#EXTM3U") === 0) continue;
      if (line.indexOf("#EXTINF") === 0) {
        var comma = line.indexOf(",");
        pendingTitle = comma >= 0 ? line.slice(comma + 1).trim() : null;
        continue;
      }
      if (line.charAt(0) === "#") continue; // other tags (#EXT-X-*, #EXTGRP, etc.) — skip
      var url = resolve(line);
      if (url && /^https?:\/\//i.test(url)) {
        items.push({ title: pendingTitle || ("Video " + (items.length + 1)), url: url });
      }
      pendingTitle = null;
    }
    return items;
  }

  // ---------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------
  var $main = document.getElementById("main");
  var $tabs = document.getElementById("tabs");
  var $ftr = document.getElementById("ftr");
  var $clock = document.getElementById("clock");
  var $playerView = document.getElementById("playerView");
  var $video = document.getElementById("video");
  var $pTitle = document.getElementById("pTitle");
  var $pState = document.getElementById("pState");
  var $pHud = document.getElementById("pHud");
  var $pBar = document.getElementById("pBar");
  var $pCur = document.getElementById("pCur");
  var $pDur = document.getElementById("pDur");
  var $pBadgeLive = document.getElementById("pBadgeLive");
  var $formView = document.getElementById("formView");
  var $formBody = document.getElementById("formBody");
  var $formHeading = document.getElementById("formHeading");
  var $toast = document.getElementById("toast");

  // ---------------------------------------------------------------
  // Clock
  // ---------------------------------------------------------------
  function tickClock() {
    var d = new Date();
    var h = d.getHours(), m = d.getMinutes();
    $clock.textContent = (h < 10 ? "0" + h : h) + ":" + (m < 10 ? "0" + m : m);
  }
  tickClock();
  setInterval(tickClock, 15000);

  // ---------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------
  var toastTimer = null;
  function toast(msg, isErr) {
    $toast.textContent = msg;
    $toast.className = "on" + (isErr ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $toast.className = ""; }, 2200);
  }

  // ---------------------------------------------------------------
  // Flat list of currently focusable elements (rebuilt per render)
  // ---------------------------------------------------------------
  var focusables = [];

  function setFocus(i) {
    if (!focusables.length) return;
    if (i < 0) i = 0;
    if (i >= focusables.length) i = focusables.length - 1;
    for (var k = 0; k < focusables.length; k++) {
      focusables[k].classList.toggle("focus", k === i);
    }
    state.focusIndex = i;
    var el = focusables[i];
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ block: "nearest" });
    }
  }

  function activateFocused() {
    var el = focusables[state.focusIndex];
    if (el && el.__activate) el.__activate();
  }

  // ---------------------------------------------------------------
  // Renderers
  // ---------------------------------------------------------------
  function setTabsUI() {
    var tabs = $tabs.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle("active", tabs[i].getAttribute("data-tab") === state.tab);
    }
  }

  function render() {
    setTabsUI();
    $main.innerHTML = "";
    focusables = [];

    if (state.tab === "home") renderHome();
    else if (state.tab === "channels") renderChannelsGrid();
    else if (state.tab === "add") renderAddEntry();

    setFocus(0);
    updateFooterHints();
  }

  function updateFooterHints() {
    if (state.tab === "add") {
      $ftr.innerHTML = "<span><b>OK</b> open</span><span><b>◂▸</b> tabs</span><span class='r'><b>0</b> back</span>";
    } else {
      $ftr.innerHTML = "<span><b>OK</b> select</span><span><b>◂▸</b> tabs</span><span class='r'><b>0</b> back</span>";
    }
  }

  // ---- HOME: flat feed of all videos across all channels ----
  function renderHome() {
    var eyebrow = document.createElement("div");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "Up next";
    $main.appendChild(eyebrow);

    var items = [];
    state.channels.forEach(function (ch) {
      ch.urls.forEach(function (v) {
        items.push({ channel: ch, video: v });
      });
    });

    if (!items.length) {
      $main.appendChild(emptyState("Nothing yet", "Add a stream from the Add tab."));
      return;
    }

    items.forEach(function (it, idx) {
      var row = document.createElement("div");
      row.className = "item";
      row.style.position = "relative";
      var isLive = it.channel.urls.length === 1;
      row.innerHTML =
        '<div class="idx">' + (idx + 1) + '</div>' +
        '<div class="meta">' +
          '<div class="ttl">' + escapeHtml(it.video.title || it.channel.name) + '</div>' +
          '<div class="sub">' + escapeHtml(it.channel.name) + '</div>' +
        '</div>' +
        (isLive ? '<div class="tag">Live</div>' : '');
      row.__activate = function () {
        playVideo(it.channel, it.video);
      };
      $main.appendChild(row);
      focusables.push(row);
    });
  }

  // ---- CHANNELS: grid, numbered for quick recognition ----
  function renderChannelsGrid() {
    var eyebrow = document.createElement("div");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "Channels";
    $main.appendChild(eyebrow);

    if (!state.channels.length) {
      $main.appendChild(emptyState("No channels", "Add one from the Add tab."));
      return;
    }

    var grid = document.createElement("div");
    grid.className = "grid";
    state.channels.forEach(function (ch, idx) {
      var tile = document.createElement("div");
      tile.className = "tile";
      var isLive = ch.urls.length === 1;
      tile.innerHTML =
        '<span class="num">' + (idx + 1) + '</span>' +
        (isLive ? '<span class="live-dot">●</span>' : '') +
        '<div class="nm">' + escapeHtml(ch.name) + '</div>' +
        '<div class="ct">' + (isLive ? "Live stream" : ch.urls.length + " videos") + '</div>';
      tile.__activate = function () {
        openChannel(ch);
      };
      grid.appendChild(tile);
      focusables.push(tile);
    });
    $main.appendChild(grid);
  }

  function openChannel(ch) {
    if (ch.urls.length === 1) {
      playVideo(ch, ch.urls[0]);
      return;
    }
    state.activeChannel = ch;
    state.view = "channelDetail";
    renderChannelDetail(ch);
  }

  function renderChannelDetail(ch) {
    $main.innerHTML = "";
    focusables = [];

    var eyebrow = document.createElement("div");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = ch.name;
    $main.appendChild(eyebrow);

    ch.urls.forEach(function (v, idx) {
      var row = document.createElement("div");
      row.className = "item";
      row.innerHTML =
        '<div class="idx">' + (idx + 1) + '</div>' +
        '<div class="meta"><div class="ttl">' + escapeHtml(v.title) + '</div></div>';
      row.__activate = function () { playVideo(ch, v); };
      $main.appendChild(row);
      focusables.push(row);
    });

    setFocus(0);
  }

  function emptyState(big, sub) {
    var d = document.createElement("div");
    d.className = "empty";
    d.innerHTML = '<span class="big">▸</span>' + escapeHtml(big) + '<div style="margin-top:4px">' + escapeHtml(sub) + '</div>';
    return d;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---------------------------------------------------------------
  // ADD tab: entry menu -> form
  // ---------------------------------------------------------------
  function renderAddEntry() {
    var eyebrow = document.createElement("div");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "Add";
    $main.appendChild(eyebrow);

    var opts = [
      { label: "New channel", sub: "Create an empty channel", fn: showNewChannelForm },
      { label: "Add video / stream URL", sub: "Attach an .m3u8 link to a channel", fn: showAddUrlForm },
      { label: "Manage channels", sub: "Rename or delete", fn: showManageList }
    ];
    opts.forEach(function (o) {
      var row = document.createElement("div");
      row.className = "item";
      row.innerHTML =
        '<div class="idx">▸</div>' +
        '<div class="meta"><div class="ttl">' + o.label + '</div><div class="sub">' + o.sub + '</div></div>';
      row.__activate = o.fn;
      $main.appendChild(row);
      focusables.push(row);
    });
  }

  // ---- generic form engine (keyboard/d-pad friendly) ----
  var formFocusables = [];
  var formFocusIdx = 0;

  function openForm(heading, fields, onSubmit) {
    state.view = "form";
    $formHeading.textContent = heading;
    $formBody.innerHTML = "";
    formFocusables = [];

    fields.forEach(function (f) {
      var wrap = document.createElement("div");
      wrap.className = "field";
      var label = document.createElement("label");
      label.textContent = f.label;
      wrap.appendChild(label);

      var input;
      if (f.type === "select") {
        input = document.createElement("select");
        f.options.forEach(function (opt) {
          var o = document.createElement("option");
          o.value = opt.value; o.textContent = opt.label;
          input.appendChild(o);
        });
      } else {
        input = document.createElement("input");
        input.type = "text";
        input.placeholder = f.placeholder || "";
        input.value = f.value || "";
      }
      input.__field = f.key;
      wrap.appendChild(input);
      $formBody.appendChild(wrap);
      formFocusables.push({ el: wrap, input: input, isBtn: false });
    });

    var btnRow = document.createElement("div");
    btnRow.className = "btnrow";
    var saveBtn = document.createElement("div");
    saveBtn.className = "btn primary";
    saveBtn.textContent = "Save";
    saveBtn.__activate = function () {
      var data = {};
      formFocusables.forEach(function (f) {
        if (!f.isBtn) data[f.input.__field] = f.input.value.trim();
      });
      onSubmit(data);
    };
    btnRow.appendChild(saveBtn);
    formFocusables.push({ el: saveBtn, isBtn: true, __activate: saveBtn.__activate });

    var cancelBtn = document.createElement("div");
    cancelBtn.className = "btn";
    cancelBtn.textContent = "Cancel";
    cancelBtn.__activate = function () { switchTab("add"); };
    btnRow.appendChild(cancelBtn);
    formFocusables.push({ el: cancelBtn, isBtn: true, __activate: cancelBtn.__activate });

    $formBody.appendChild(btnRow);

    if (fields.hint) {
      var hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = fields.hint;
      $formBody.appendChild(hint);
    }

    formFocusIdx = 0;
    setFormFocus(0);
    $formView.classList.add("on");
  }

  function setFormFocus(i) {
    if (i < 0) i = 0;
    if (i >= formFocusables.length) i = formFocusables.length - 1;
    formFocusIdx = i;
    formFocusables.forEach(function (f, k) {
      f.el.classList.toggle("focus", k === i);
    });
    var cur = formFocusables[i];
    if (cur.el.scrollIntoView) cur.el.scrollIntoView({ block: "nearest" });
  }

  function closeForm() {
    $formView.classList.remove("on");
    state.view = "list";
  }

  function showNewChannelForm() {
    openForm("New channel", withHint([
      { key: "name", label: "Channel name", placeholder: "e.g. My Anime" }
    ], "This creates an empty channel. Add episode/stream URLs to it next from 'Add video / stream URL'."), function (data) {
      if (!data.name) { toast("Enter a name", true); return; }
      state.channels.push({ id: uid(), name: data.name, urls: [] });
      saveChannels();
      toast("Channel added");
      closeForm();
      switchTab("channels");
    });
  }

  function showAddUrlForm() {
    if (!state.channels.length) {
      toast("Create a channel first", true);
      return;
    }
    var opts = state.channels.map(function (c) { return { value: c.id, label: c.name }; });

    state.view = "form";
    $formHeading.textContent = "Add video URL";
    $formBody.innerHTML = "";
    formFocusables = [];

    // --- Upload button (parses .m3u8/.m3u list files) ---
    // Implemented as a <label> wrapping a real (visually-hidden) file input.
    // This is the most reliable trigger pattern on thin/older browsers —
    // native label-for-input association opens the picker even when
    // synthetic input.click() calls from unrelated elements are blocked.
    var uploadWrap = document.createElement("div");
    uploadWrap.className = "field";
    var uploadLabel = document.createElement("label");
    uploadLabel.textContent = "Upload playlist file";
    uploadWrap.appendChild(uploadLabel);

    var uploadBtn = document.createElement("label");
    uploadBtn.className = "filebtn";
    uploadBtn.setAttribute("for", "fileInputReal");
    var fileInputReal = document.createElement("input");
    fileInputReal.type = "file";
    fileInputReal.id = "fileInputReal";
    fileInputReal.accept = ".m3u8,.m3u,audio/x-mpegurl,application/x-mpegurl,application/vnd.apple.mpegurl";
    var btnText = document.createElement("span");
    btnText.textContent = "Choose .m3u8 / .m3u file";
    var fnameEl = document.createElement("span");
    fnameEl.className = "fname";
    fnameEl.textContent = "No file selected";
    uploadBtn.appendChild(fileInputReal);
    uploadBtn.appendChild(btnText);
    uploadBtn.appendChild(fnameEl);
    // D-pad Enter support: focusing this row + pressing Enter clicks the nested real input
    uploadBtn.__activate = function () { fileInputReal.click(); };
    uploadWrap.appendChild(uploadBtn);
    $formBody.appendChild(uploadWrap);
    formFocusables.push({ el: uploadBtn, isBtn: true, __activate: uploadBtn.__activate });

    // channel select applies to BOTH upload import and manual add below
    var chWrap = document.createElement("div");
    chWrap.className = "field";
    var chLabel = document.createElement("label");
    chLabel.textContent = "Target channel";
    chWrap.appendChild(chLabel);
    var chSelect = document.createElement("select");
    opts.forEach(function (o) {
      var op = document.createElement("option");
      op.value = o.value; op.textContent = o.label;
      chSelect.appendChild(op);
    });
    chWrap.appendChild(chSelect);
    $formBody.appendChild(chWrap);
    formFocusables.push({ el: chWrap, input: chSelect, isBtn: false });

    fileInputReal.onchange = function () {
      var f = fileInputReal.files && fileInputReal.files[0];
      if (!f) return;
      fnameEl.textContent = f.name;
      var reader = new FileReader();
      reader.onload = function () {
        var parsed = parseM3U(String(reader.result || ""));
        if (!parsed.length) {
          toast("No playable entries found in file", true);
          return;
        }
        showImportPreview(parsed, chSelect.value);
      };
      reader.onerror = function () {
        toast("Could not read file", true);
      };
      reader.readAsText(f);
    };

    var orsep = document.createElement("div");
    orsep.className = "orsep";
    orsep.textContent = "or add one manually";
    $formBody.appendChild(orsep);

    // --- Manual single-URL fields (existing flow) ---
    var titleWrap = document.createElement("div");
    titleWrap.className = "field";
    titleWrap.innerHTML = '<label>Title</label>';
    var titleInput = document.createElement("input");
    titleInput.type = "text"; titleInput.placeholder = "e.g. Episode 3";
    titleWrap.appendChild(titleInput);
    $formBody.appendChild(titleWrap);
    formFocusables.push({ el: titleWrap, input: titleInput, isBtn: false });

    var urlWrap = document.createElement("div");
    urlWrap.className = "field";
    urlWrap.innerHTML = '<label>.m3u8 URL</label>';
    var urlInput = document.createElement("input");
    urlInput.type = "text"; urlInput.placeholder = "https://…/playlist.m3u8";
    urlWrap.appendChild(urlInput);
    $formBody.appendChild(urlWrap);
    formFocusables.push({ el: urlWrap, input: urlInput, isBtn: false });

    var btnRow = document.createElement("div");
    btnRow.className = "btnrow";
    var saveBtn = document.createElement("div");
    saveBtn.className = "btn primary";
    saveBtn.textContent = "Save";
    saveBtn.__activate = function () {
      var url = urlInput.value.trim();
      if (!url || !/^https?:\/\//i.test(url)) { toast("Enter a valid URL", true); return; }
      var ch = state.channels.find(function (c) { return c.id === chSelect.value; });
      if (!ch) { toast("Channel not found", true); return; }
      ch.urls.push({ id: uid(), title: titleInput.value.trim() || ("Video " + (ch.urls.length + 1)), url: url });
      saveChannels();
      toast("Added to " + ch.name);
      closeForm();
      switchTab("channels");
    };
    btnRow.appendChild(saveBtn);
    formFocusables.push({ el: saveBtn, isBtn: true, __activate: saveBtn.__activate });

    var cancelBtn = document.createElement("div");
    cancelBtn.className = "btn";
    cancelBtn.textContent = "Cancel";
    cancelBtn.__activate = function () { switchTab("add"); };
    btnRow.appendChild(cancelBtn);
    formFocusables.push({ el: cancelBtn, isBtn: true, __activate: cancelBtn.__activate });
    $formBody.appendChild(btnRow);

    var hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Tip: a channel with exactly 1 URL plays instantly (Live). 2+ URLs shows an episode list. Uploading a playlist file imports every entry into the selected channel at once.";
    $formBody.appendChild(hint);

    formFocusIdx = 0;
    setFormFocus(0);
    $formView.classList.add("on");
  }

  // --- Import preview after a playlist file is parsed ---
  function showImportPreview(parsedItems, defaultChannelId) {
    state.view = "form";
    $formHeading.textContent = "Import preview";
    $formBody.innerHTML = "";
    formFocusables = [];

    var opts = state.channels.map(function (c) { return { value: c.id, label: c.name }; });

    var chWrap = document.createElement("div");
    chWrap.className = "field";
    chWrap.innerHTML = '<label>Import into channel</label>';
    var chSelect = document.createElement("select");
    opts.forEach(function (o) {
      var op = document.createElement("option");
      op.value = o.value; op.textContent = o.label;
      if (o.value === defaultChannelId) op.selected = true;
      chSelect.appendChild(op);
    });
    chWrap.appendChild(chSelect);
    $formBody.appendChild(chWrap);
    formFocusables.push({ el: chWrap, input: chSelect, isBtn: false });

    var countDiv = document.createElement("div");
    countDiv.className = "importcount";
    countDiv.textContent = parsedItems.length + " entr" + (parsedItems.length === 1 ? "y" : "ies") + " found";
    $formBody.appendChild(countDiv);

    var listDiv = document.createElement("div");
    listDiv.className = "importlist";
    parsedItems.slice(0, 50).forEach(function (it) {
      var row = document.createElement("div");
      row.className = "importrow";
      row.textContent = it.title;
      listDiv.appendChild(row);
    });
    $formBody.appendChild(listDiv);

    var btnRow = document.createElement("div");
    btnRow.className = "btnrow";
    var importBtn = document.createElement("div");
    importBtn.className = "btn primary";
    importBtn.textContent = "Import all";
    importBtn.__activate = function () {
      var ch = state.channels.find(function (c) { return c.id === chSelect.value; });
      if (!ch) { toast("Channel not found", true); return; }
      parsedItems.forEach(function (it) {
        ch.urls.push({ id: uid(), title: it.title, url: it.url });
      });
      saveChannels();
      toast("Imported " + parsedItems.length + " into " + ch.name);
      closeForm();
      switchTab("channels");
    };
    btnRow.appendChild(importBtn);
    formFocusables.push({ el: importBtn, isBtn: true, __activate: importBtn.__activate });

    var cancelBtn = document.createElement("div");
    cancelBtn.className = "btn";
    cancelBtn.textContent = "Cancel";
    cancelBtn.__activate = function () { showAddUrlForm(); };
    btnRow.appendChild(cancelBtn);
    formFocusables.push({ el: cancelBtn, isBtn: true, __activate: cancelBtn.__activate });
    $formBody.appendChild(btnRow);

    formFocusIdx = 0;
    setFormFocus(0);
    $formView.classList.add("on");
  }

  function withHint(fields, hint) {
    fields.hint = hint;
    return fields;
  }

  function showManageList() {
    $main.innerHTML = "";
    focusables = [];
    var eyebrow = document.createElement("div");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "Manage channels";
    $main.appendChild(eyebrow);

    if (!state.channels.length) {
      $main.appendChild(emptyState("No channels", "Nothing to manage."));
      return;
    }

    state.channels.forEach(function (ch, idx) {
      var row = document.createElement("div");
      row.className = "item";
      row.innerHTML =
        '<div class="idx">' + (idx + 1) + '</div>' +
        '<div class="meta"><div class="ttl">' + escapeHtml(ch.name) + '</div>' +
        '<div class="sub">' + ch.urls.length + ' url(s) · OK to delete</div></div>';
      row.__activate = function () {
        if (confirmDelete(ch)) {
          state.channels = state.channels.filter(function (c) { return c.id !== ch.id; });
          saveChannels();
          toast("Deleted " + ch.name);
          showManageList();
        }
      };
      $main.appendChild(row);
      focusables.push(row);
    });
    setFocus(0);
  }

  function confirmDelete(ch) {
    // Simple confirm() works fine on these browsers and is native/cheap.
    return confirm('Delete "' + ch.name + '" and its ' + ch.urls.length + ' url(s)?');
  }

  // ---------------------------------------------------------------
  // TABS
  // ---------------------------------------------------------------
  function switchTab(tab) {
    state.tab = tab;
    state.view = "list";
    render();
  }

  $tabs.addEventListener("click", function (e) {
    var t = e.target.closest(".tab");
    if (t) switchTab(t.getAttribute("data-tab"));
  });

  // ---------------------------------------------------------------
  // PLAYER
  // ---------------------------------------------------------------
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    var m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ":" + (sec < 10 ? "0" + sec : sec);
  }

  function playVideo(channel, video) {
    state.view = "player";
    $playerView.classList.add("on");
    $pTitle.textContent = video.title || channel.name;
    $pState.textContent = "Loading…";
    $pBar.style.width = "0%";
    $pCur.textContent = "0:00";
    $pDur.textContent = "0:00";
    var isLive = channel.urls.length === 1;
    $pBadgeLive.classList.toggle("on", isLive);

    destroyHls();

    var src = video.url;
    if (window.Hls && window.Hls.isSupported()) {
      var hls = new Hls({ maxBufferLength: 20, enableWorker: true });
      state.hls = hls;
      hls.on(Hls.Events.ERROR, function (evt, data) {
        if (data && data.fatal) {
          $pState.textContent = "Playback error";
          toast("Stream error: " + (data.details || "unknown"), true);
        }
      });
      hls.loadSource(src);
      hls.attachMedia($video);
      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        $pState.textContent = "";
        $video.play().catch(function () {});
      });
    } else if ($video.canPlayType("application/vnd.apple.mpegurl")) {
      $video.src = src;
      $video.addEventListener("loadedmetadata", function () {
        $pState.textContent = "";
        $video.play().catch(function () {});
      }, { once: true });
    } else {
      $pState.textContent = "HLS not supported on this browser";
      toast("This device can't play HLS streams", true);
      return;
    }

    showHud();
  }

  function destroyHls() {
    if (state.hls) {
      try { state.hls.destroy(); } catch (e) {}
      state.hls = null;
    }
    $video.pause();
    $video.removeAttribute("src");
    try { $video.load(); } catch (e) {}
  }

  function closePlayer() {
    destroyHls();
    $playerView.classList.remove("on");
    state.view = state.activeChannel ? "channelDetail" : "list";
    clearTimeout(state.hudTimer);
  }

  function showHud() {
    $pHud.classList.remove("hide");
    clearTimeout(state.hudTimer);
    state.hudTimer = setTimeout(function () { $pHud.classList.add("hide"); }, 3000);
  }

  $video.addEventListener("timeupdate", function () {
    var d = $video.duration, c = $video.currentTime;
    if (isFinite(d) && d > 0) {
      $pBar.style.width = Math.min(100, (c / d) * 100) + "%";
      $pDur.textContent = fmtTime(d);
    } else {
      $pBar.style.width = "100%";
      $pDur.textContent = "LIVE";
    }
    $pCur.textContent = fmtTime(c);
  });
  $video.addEventListener("waiting", function () { $pState.textContent = "Buffering…"; });
  $video.addEventListener("playing", function () { $pState.textContent = ""; });
  $video.addEventListener("click", showHud);

  // ---------------------------------------------------------------
  // KEY HANDLING (D-pad first-class, touch/click as bonus)
  // Feature phone key codes vary; we handle both KeyboardEvent.key
  // (modern) and legacy numeric keyCodes some KaiOS/webviews still send.
  // ---------------------------------------------------------------
  var TAB_ORDER = ["home", "channels", "add"];

  function onKeyDown(e) {
    var key = e.key;
    // normalize legacy keyCodes -> key names
    if (!key || key === "Unidentified") {
      var map = { 37: "ArrowLeft", 38: "ArrowUp", 39: "ArrowRight", 40: "ArrowDown", 13: "Enter", 8: "Backspace", 27: "Backspace" };
      key = map[e.keyCode] || key;
    }

    // PLAYER context
    if (state.view === "player") {
      if (key === "Backspace" || key === "SoftLeft" || key === "0") { e.preventDefault(); closePlayer(); return; }
      if (key === "Enter" || key === " ") {
        e.preventDefault();
        if ($video.paused) $video.play().catch(function(){}); else $video.pause();
        showHud();
        return;
      }
      if (key === "ArrowRight") { $video.currentTime = Math.min(($video.duration || 1e9), $video.currentTime + 10); showHud(); return; }
      if (key === "ArrowLeft") { $video.currentTime = Math.max(0, $video.currentTime - 10); showHud(); return; }
      if (key === "ArrowUp") { $video.volume = Math.min(1, $video.volume + 0.1); showHud(); return; }
      if (key === "ArrowDown") { $video.volume = Math.max(0, $video.volume - 0.1); showHud(); return; }
      return;
    }

    // FORM context
    if (state.view === "form") {
      if (key === "Backspace") { e.preventDefault(); closeForm(); return; }
      if (key === "ArrowDown") { e.preventDefault(); setFormFocus(formFocusIdx + 1); return; }
      if (key === "ArrowUp") { e.preventDefault(); setFormFocus(formFocusIdx - 1); return; }
      if (key === "Enter") {
        var cur = formFocusables[formFocusIdx];
        if (cur && cur.isBtn) { e.preventDefault(); cur.__activate(); }
        // else: let Enter fall through to input (mobile keyboards use their own submit)
        return;
      }
      return;
    }

    // CHANNEL DETAIL context (uses same focusables array, back returns to grid)
    if (state.view === "channelDetail") {
      if (key === "Backspace" || key === "0") { e.preventDefault(); state.view = "list"; state.activeChannel = null; render(); return; }
    }

    // LIST / GRID context (home, channels, channelDetail, add)
    if (key === "ArrowDown") { e.preventDefault(); moveFocus(1); return; }
    if (key === "ArrowUp") { e.preventDefault(); moveFocus(-1); return; }
    if (key === "ArrowRight") {
      if (state.tab === "channels" && state.view === "list") { e.preventDefault(); moveFocus(1); return; }
      e.preventDefault(); cycleTab(1); return;
    }
    if (key === "ArrowLeft") {
      if (state.tab === "channels" && state.view === "list") { e.preventDefault(); moveFocus(-1); return; }
      e.preventDefault(); cycleTab(-1); return;
    }
    if (key === "Enter") { e.preventDefault(); activateFocused(); return; }
    if (key === "Backspace" || key === "0") {
      e.preventDefault();
      if (state.view === "channelDetail") { state.view = "list"; state.activeChannel = null; render(); }
      return;
    }
    // number keys 1-9 jump directly to nth item (teletext-style direct access)
    if (/^[1-9]$/.test(key)) {
      var n = parseInt(key, 10) - 1;
      if (n < focusables.length) { setFocus(n); }
    }
  }

  function moveFocus(delta) {
    setFocus(state.focusIndex + delta);
  }

  function cycleTab(delta) {
    if (state.view !== "list") return;
    var i = TAB_ORDER.indexOf(state.tab);
    i = (i + delta + TAB_ORDER.length) % TAB_ORDER.length;
    switchTab(TAB_ORDER[i]);
  }

  document.addEventListener("keydown", onKeyDown);

  // touch fallback: tap already works via click bubbling since __activate
  // is invoked on click too, for testing in a normal desktop browser
  $main.addEventListener("click", function (e) {
    var el = e.target.closest(".item, .tile");
    if (el && el.__activate) el.__activate();
  });
  $formBody.addEventListener("click", function (e) {
    // .filebtn is a native <label for="..."> — tapping it already opens
    // the file picker natively. Don't also fire __activate() here or
    // some browsers will trigger the picker twice.
    if (e.target.closest(".filebtn")) {
      var lbl = e.target.closest(".filebtn");
      var idx = formFocusables.findIndex(function(f){ return f.el === lbl; });
      if (idx >= 0) setFormFocus(idx);
      return;
    }
    var el = e.target.closest(".btn");
    if (el && el.__activate) {
      var idx2 = formFocusables.findIndex(function(f){ return f.el === el; });
      if (idx2 >= 0) setFormFocus(idx2);
      el.__activate();
    }
  });
  $playerView.addEventListener("click", function (e) {
    if (e.target === $video) { /* handled by video click listener above */ }
  });

  // back button (Escape on desktop testing, or hardware back via keydown above)
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (state.view === "player") closePlayer();
      else if (state.view === "form") closeForm();
    }
  });

  // ---------------------------------------------------------------
  // INIT
  // ---------------------------------------------------------------
  state.channels = loadChannels();
  render();
})();
