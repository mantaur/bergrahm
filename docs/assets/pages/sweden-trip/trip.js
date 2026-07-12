(function () {
  "use strict";

  var SHEET_ID = "1WBhKmnyD-cJf9XkfDFEPN6INUymGPkyWPha9Q69_T64";
  var CSV_URL = "https://docs.google.com/spreadsheets/d/" + SHEET_ID + "/export?format=csv";
  var CACHE_KEY = "sweden-trip-cache-v1";

  var BUCKETS = [
    { id: "quick", label: "Quick (<1h)", test: function (h) { return h !== null && h < 1; } },
    { id: "few", label: "A few hours", test: function (h) { return h !== null && h >= 1 && h < 4; } },
    { id: "half", label: "Half day", test: function (h) { return h !== null && h >= 4 && h < 6; } },
    { id: "full", label: "Full day", test: function (h) { return h !== null && h >= 6; } },
    { id: "flex", label: "Flexible", test: function (h) { return h === null; } }
  ];

  function parseCSV(text) {
    var rows = [];
    var row = [];
    var field = "";
    var inQuotes = false;

    for (var i = 0; i < text.length; i++) {
      var c = text[i];

      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += c;
        }
        continue;
      }

      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\r") {
        // ignore, \n handles the line break
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += c;
      }
    }
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter(function (r) { return r.some(function (v) { return v.trim() !== ""; }); });
  }

  function rowsToItems(rows) {
    if (rows.length === 0) return [];
    var header = rows[0].map(function (h) { return h.trim().toLowerCase(); });

    function colIndex(names) {
      for (var i = 0; i < header.length; i++) {
        if (names.indexOf(header[i]) !== -1) return i;
      }
      return -1;
    }

    var idxName = colIndex(["name"]);
    var idxTime = colIndex(["time estimate", "time", "duration"]);
    var idxDesc = colIndex(["description", "desc", "notes"]);
    var idxMedia = colIndex(["photo", "image", "img", "media", "video"]);
    var idxLink = colIndex(["link", "url", "maps", "map link"]);
    var idxLat = colIndex(["lat", "latitude"]);
    var idxLng = colIndex(["lng", "lon", "long", "longitude"]);

    var items = [];
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      var name = idxName !== -1 ? (row[idxName] || "").trim() : "";
      if (!name) continue;

      var timeRaw = idxTime !== -1 ? (row[idxTime] || "").trim() : "";
      var desc = idxDesc !== -1 ? (row[idxDesc] || "").trim() : "";
      var mediaRaw = idxMedia !== -1 ? (row[idxMedia] || "").trim() : "";
      var link = idxLink !== -1 ? (row[idxLink] || "").trim() : "";
      var lat = idxLat !== -1 ? parseFloat(row[idxLat]) : NaN;
      var lng = idxLng !== -1 ? parseFloat(row[idxLng]) : NaN;

      items.push({
        name: name,
        timeRaw: timeRaw,
        hours: parseHours(timeRaw),
        desc: desc,
        media: resolveMedia(mediaRaw),
        link: link || mapsLink(name),
        lat: isNaN(lat) ? null : lat,
        lng: isNaN(lng) ? null : lng
      });
    }
    return items;
  }

  function parseHours(text) {
    var t = text.toLowerCase();
    if (!t || t.indexOf("n/a") !== -1) return null;
    if (t.indexOf("full day") !== -1) return 8;
    if (t.indexOf("half day") !== -1) return 4;

    var range = t.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/);
    if (range) return (parseFloat(range[1]) + parseFloat(range[2])) / 2;

    var single = t.match(/(\d+(?:\.\d+)?)/);
    if (single) return parseFloat(single[1]);

    return null;
  }

  var COORD_RE = /^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/;

  function mapsLink(name) {
    var query = COORD_RE.test(name) ? name : name + ", Stockholm, Sweden";
    return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(query);
  }

  function resolveMedia(value) {
    if (!value) return "";
    if (/^https?:\/\//i.test(value)) return value;
    return "photos/" + value;
  }

  function isVideo(path) {
    return /\.(mp4|webm|mov|m4v)$/i.test(path);
  }

  function bucketFor(hours) {
    for (var i = 0; i < BUCKETS.length; i++) {
      if (BUCKETS[i].test(hours)) return BUCKETS[i].id;
    }
    return "flex";
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function mediaHtml(item) {
    var letter = escapeHtml(item.name.charAt(0).toUpperCase());

    if (!item.media) return '<div class="trip-photo-placeholder">' + letter + "</div>";

    if (isVideo(item.media)) {
      return (
        '<video class="trip-photo" controls preload="metadata" playsinline muted>' +
        '<source src="' + escapeHtml(item.media) + '">' +
        "</video>"
      );
    }

    // Sibling placeholder stays hidden unless the image 404s; onerror swaps visibility
    // (kept as plain statements, not injected markup, so nested quotes can't break the attribute).
    return (
      '<img class="trip-photo" src="' + escapeHtml(item.media) + '" alt="" loading="lazy" ' +
      "onerror=\"this.style.display='none';this.nextElementSibling.style.display='flex';\">" +
      '<div class="trip-photo-placeholder" style="display:none">' + letter + "</div>"
    );
  }

  function cardHtml(item) {
    var badge = item.timeRaw ? escapeHtml(item.timeRaw) : "flexible";

    return (
      '<a class="trip-card" data-bucket="' + bucketFor(item.hours) + '" data-search="' +
      escapeHtml((item.name + " " + item.desc).toLowerCase()) +
      '" href="' + escapeHtml(item.link) + '" target="_blank" rel="noreferrer">' +
      mediaHtml(item) +
      '<div class="trip-card-body">' +
      '<h3 class="trip-card-title">' + escapeHtml(item.name) + "</h3>" +
      '<span class="trip-badge">' + badge + "</span>" +
      '<p class="trip-card-desc">' + escapeHtml(item.desc) + "</p>" +
      "</div></a>"
    );
  }

  function buildMap(items) {
    if (typeof L === "undefined") return null;

    var map = L.map("trip-map", { scrollWheelZoom: true });
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerografica, IGN, IGP, UPR-EGP, and the GIS User Community"
    }).addTo(map);

    var markerLayer = L.layerGroup().addTo(map);
    var entries = [];

    items.forEach(function (item) {
      if (item.lat === null || item.lng === null) return;
      var badge = item.timeRaw ? escapeHtml(item.timeRaw) : "flexible";
      var popupHtml =
        '<div class="trip-popup-title">' + escapeHtml(item.name) + "</div>" +
        '<span class="trip-badge">' + badge + "</span>" +
        '<p class="trip-popup-desc">' + escapeHtml(item.desc) + "</p>" +
        '<a class="trip-open-link" href="' + escapeHtml(item.link) + '" target="_blank" rel="noreferrer">Open in Maps &rarr;</a>';

      var marker = L.marker([item.lat, item.lng]).bindPopup(popupHtml, { className: "trip-popup" });
      markerLayer.addLayer(marker);
      entries.push({
        marker: marker,
        bucket: bucketFor(item.hours),
        search: (item.name + " " + item.desc).toLowerCase()
      });
    });

    if (entries.length) {
      var group = L.featureGroup(entries.map(function (e) { return e.marker; }));
      map.fitBounds(group.getBounds().pad(0.15));
    } else {
      map.setView([59.33, 18.06], 12);
    }

    return { map: map, markerLayer: markerLayer, entries: entries };
  }

  function render(items) {
    var grid = document.getElementById("trip-grid");
    var chipsEl = document.getElementById("trip-chips");
    var searchEl = document.getElementById("trip-search");
    var mapEl = document.getElementById("trip-map");
    var listBtn = document.getElementById("trip-view-list");
    var mapBtn = document.getElementById("trip-view-map");
    var mapState = null;

    grid.innerHTML = items.map(cardHtml).join("");

    var presentBuckets = {};
    items.forEach(function (item) { presentBuckets[bucketFor(item.hours)] = true; });

    var activeBucket = "all";
    chipsEl.innerHTML =
      '<div class="trip-chip active" data-bucket="all">All</div>' +
      BUCKETS.filter(function (b) { return presentBuckets[b.id]; })
        .map(function (b) { return '<div class="trip-chip" data-bucket="' + b.id + '">' + b.label + "</div>"; })
        .join("");

    function applyFilters() {
      var query = searchEl.value.trim().toLowerCase();
      var cards = grid.querySelectorAll(".trip-card");
      var visible = 0;
      cards.forEach(function (card) {
        var matchesBucket = activeBucket === "all" || card.getAttribute("data-bucket") === activeBucket;
        var matchesQuery = !query || card.getAttribute("data-search").indexOf(query) !== -1;
        var show = matchesBucket && matchesQuery;
        card.style.display = show ? "" : "none";
        if (show) visible++;
      });

      var existingEmpty = grid.querySelector(".trip-empty");
      if (visible === 0 && !existingEmpty) {
        var empty = document.createElement("div");
        empty.className = "trip-empty";
        empty.textContent = "Nothing matches. Try a different search or filter.";
        grid.appendChild(empty);
      } else if (visible > 0 && existingEmpty) {
        existingEmpty.remove();
      }

      if (mapState) {
        mapState.entries.forEach(function (entry) {
          var matchesBucket = activeBucket === "all" || entry.bucket === activeBucket;
          var matchesQuery = !query || entry.search.indexOf(query) !== -1;
          var show = matchesBucket && matchesQuery;
          var onMap = mapState.markerLayer.hasLayer(entry.marker);
          if (show && !onMap) mapState.markerLayer.addLayer(entry.marker);
          if (!show && onMap) mapState.markerLayer.removeLayer(entry.marker);
        });
      }
    }

    chipsEl.addEventListener("click", function (e) {
      var chip = e.target.closest(".trip-chip");
      if (!chip) return;
      chipsEl.querySelectorAll(".trip-chip").forEach(function (c) { c.classList.remove("active"); });
      chip.classList.add("active");
      activeBucket = chip.getAttribute("data-bucket");
      applyFilters();
    });

    // Card is a real <a>, so any click on it opens the link by default. Suppress
    // that only when the click landed on the video itself, so its native controls
    // (play/pause/seek/fullscreen) work instead of navigating away.
    grid.addEventListener("click", function (e) {
      if (e.target.closest("video")) e.preventDefault();
    });

    searchEl.addEventListener("input", applyFilters);

    listBtn.addEventListener("click", function () {
      listBtn.classList.add("active");
      mapBtn.classList.remove("active");
      grid.hidden = false;
      mapEl.hidden = true;
    });

    mapBtn.addEventListener("click", function () {
      mapBtn.classList.add("active");
      listBtn.classList.remove("active");
      grid.hidden = true;
      mapEl.hidden = false;
      if (!mapState) {
        mapState = buildMap(items);
        applyFilters();
      }
      if (mapState) mapState.map.invalidateSize();
    });
  }

  function setStatus(text) {
    document.getElementById("trip-status").textContent = text;
  }

  function loadCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function saveCache(items) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ items: items, savedAt: Date.now() }));
    } catch (e) {
      // storage unavailable, skip caching
    }
  }

  function formatSavedAt(ts) {
    try {
      return new Date(ts).toLocaleString();
    } catch (e) {
      return "earlier";
    }
  }

  async function init() {
    setStatus("Loading...");
    try {
      var res = await fetch(CSV_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      var text = await res.text();
      var items = rowsToItems(parseCSV(text));
      saveCache(items);
      render(items);
      setStatus(items.length + " recommendations, updated just now.");
    } catch (err) {
      var cached = loadCache();
      if (cached && cached.items && cached.items.length) {
        render(cached.items);
        setStatus("Offline — showing saved copy from " + formatSavedAt(cached.savedAt) + ".");
      } else {
        setStatus("Could not load the list and no offline copy is saved yet. Check your connection and reload.");
      }
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
