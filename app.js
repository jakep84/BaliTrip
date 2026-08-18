
(() => {
  const STORAGE_KEY = 'bali-trip-board-v2';
  const EDIT_KEY_STORAGE = 'bali-trip-edit-key';
  const emojis = {
    'Rice Terraces':'🌾','Water Temples':'💧','Temples':'🛕','Waterfalls':'🌊',
    'Sites':'📍','Activities':'🎟️','Spa':'🧖','Food':'🍴','Needs Confirmation':'❓'
  };

  let items = [];
  let storageMode = 'local';
  let sharedAvailable = false;
  let activeFilter = 'All';
  let search = '';
  let map;
  let markerLayer;
  let markers = new Map();
  let geoStop = false;
  let editItemId = null;
  let saveTimer = null;
  let photoQueue = [];
  let queuedPhotoIds = new Set();
  let photoWorkers = 0;

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  function deepCopy(x){ return JSON.parse(JSON.stringify(x)); }

  function normalizeItem(item) {
    return {
      photoUrl: '',
      photoThumbUrl: '',
      photoLink: '',
      photoSource: '',
      wikiTitle: '',
      imageQuery: `${item.name || ''} Bali`,
      ...item
    };
  }

  function normalizeItems(list) {
    return (Array.isArray(list) ? list : []).map(normalizeItem);
  }

  function localLoad() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return normalizeItems(JSON.parse(raw));
    } catch (_) {}
    return normalizeItems(deepCopy(window.SEED_ITEMS || []));
  }

  function localSave() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }

  async function loadState() {
    const local = localLoad();
    try {
      const res = await fetch('/api/state', { cache:'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.items)) {
          items = normalizeItems(data.items);
          storageMode = 'shared';
          sharedAvailable = true;
          setSyncStatus('Shared trip • synced');
          return;
        }
      }
    } catch (_) {}
    items = local;
    storageMode = 'local';
    setSyncStatus('This device • local');
  }

  function setSyncStatus(text){ $('#syncStatus').textContent = text; }

  async function ensureEditKey() {
    let key = localStorage.getItem(EDIT_KEY_STORAGE);
    if (!key) {
      key = prompt('Enter the shared trip edit PIN. It will stay saved on this device.');
      if (!key) return null;
      localStorage.setItem(EDIT_KEY_STORAGE, key);
    }
    return key;
  }

  function queueSave() {
    localSave();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 350);
  }

  async function saveState() {
    localSave();
    if (storageMode !== 'shared') return true;
    const key = await ensureEditKey();
    if (!key) return false;
    setSyncStatus('Saving…');
    try {
      const res = await fetch('/api/state', {
        method:'POST',
        headers:{'Content-Type':'application/json','x-trip-key':key},
        body:JSON.stringify({items})
      });
      if (res.status === 401) {
        localStorage.removeItem(EDIT_KEY_STORAGE);
        setSyncStatus('Wrong PIN • changes kept locally');
        alert('That edit PIN was not accepted. Your changes are still saved on this device.');
        return false;
      }
      if (!res.ok) throw new Error('save failed');
      setSyncStatus('Shared trip • synced');
      return true;
    } catch (_) {
      setSyncStatus('Offline • changes kept locally');
      return false;
    }
  }

  function setupMap() {
    map = L.map('map', {zoomControl:true}).setView([-8.5069,115.2625], 9);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom:19,
      attribution:'&copy; OpenStreetMap contributors'
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
  }

  function markerIcon(item) {
    return L.divIcon({
      className:'',
      html:`<div class="marker-emoji ${item.done ? 'done':''}">${emojis[item.category] || '📍'}</div>`,
      iconSize:[28,28], iconAnchor:[14,24], popupAnchor:[0,-20]
    });
  }

  function mapsUrl(item) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.query || item.name + ', Bali, Indonesia')}`;
  }

  function visible(item) {
    const categoryOk = activeFilter === 'All' || item.category === activeFilter;
    const q = search.trim().toLowerCase();
    const searchOk = !q || [item.name,item.note,item.category].join(' ').toLowerCase().includes(q);
    return categoryOk && searchOk;
  }

  function render() {
    renderFilters();
    renderProgress();
    renderList();
    renderMarkers();
  }

  function renderProgress() {
    const done = items.filter(x => x.done).length;
    $('#progressText').textContent = `${done} / ${items.length} done`;
    $('#progressBar').style.width = `${items.length ? (done/items.length)*100 : 0}%`;
  }

  function categories() {
    return ['All', ...new Set(items.map(x => x.category))];
  }

  function renderFilters() {
    const el = $('#filters');
    el.innerHTML = '';
    categories().forEach(cat => {
      const b = document.createElement('button');
      b.className = 'filter' + (cat === activeFilter ? ' active':'');
      b.textContent = cat === 'All' ? 'All' : `${emojis[cat] || '📍'} ${cat}`;
      b.onclick = () => { activeFilter = cat; render(); };
      el.appendChild(b);
    });
  }

  function renderList() {
    const list = $('#list');
    list.innerHTML = '';
    const filtered = items.filter(visible);
    if (!filtered.length) {
      list.innerHTML = '<div class="empty">No places match this filter.</div>';
      return;
    }
    const order = categories().filter(x => x !== 'All');
    order.forEach(cat => {
      const group = filtered.filter(x => x.category === cat);
      if (!group.length) return;
      const h = document.createElement('div');
      h.className = 'category-heading';
      h.textContent = `${emojis[cat] || '📍'} ${cat} • ${group.filter(x=>x.done).length}/${group.length}`;
      list.appendChild(h);
      group.forEach(item => list.appendChild(cardFor(item)));
    });
  }

  function photoThumb(item, size='card') {
    const hasPhoto = !!(item.photoThumbUrl || item.photoUrl);
    const src = item.photoThumbUrl || item.photoUrl;
    const shellClass = size === 'popup' ? 'popup-photo-shell' : 'thumb-shell';
    return `
      <div class="${shellClass}">
        ${hasPhoto
          ? `<img class="thumb-img" src="${escapeAttr(src)}" alt="${escapeAttr(item.name)} photo" loading="lazy" referrerpolicy="no-referrer" />`
          : `<div class="thumb-fallback">${emojis[item.category] || '📍'}</div>`
        }
        <div class="thumb-overlay">${escapeHtml(item.category)}</div>
      </div>
    `;
  }

  function cardFor(item) {
    const card = document.createElement('article');
    card.className = 'card' + (item.done ? ' done':'');
    card.innerHTML = `
      <input type="checkbox" class="check" ${item.done ? 'checked':''} aria-label="Mark ${escapeAttr(item.name)} done" />
      <button class="thumb-btn" type="button" aria-label="Open ${escapeAttr(item.name)} on the map">
        <div data-photo-id="${escapeAttr(item.id)}" data-photo-size="card">${photoThumb(item, 'card')}</div>
      </button>
      <div class="card-main">
        <div class="place-name">${escapeHtml(item.name)}</div>
        <div class="place-note">${escapeHtml(item.note || 'No notes yet.')}</div>
        <div class="badge-row">
          <span class="badge">${escapeHtml(item.category)}</span>
          ${item.photoUrl || item.photoThumbUrl ? `<span class="badge photo-badge">Photo</span>` : ''}
        </div>
      </div>
      <div class="card-actions">
        <button class="mini map-btn" type="button">Map</button>
        <button class="mini edit-btn" type="button">Edit</button>
      </div>
    `;

    const check = card.querySelector('.check');
    check.onchange = () => {
      item.done = check.checked;
      queueSave();
      render();
    };

    card.querySelector('.thumb-btn').onclick = () => focusItem(item);
    card.querySelector('.map-btn').onclick = () => focusItem(item);
    card.querySelector('.edit-btn').onclick = () => openEdit(item);

    schedulePhoto(item);
    return card;
  }

  function popupHtml(item) {
    return `
      <div class="popup-card">
        <div data-photo-id="${escapeAttr(item.id)}" data-photo-size="popup">
          ${photoThumb(item, 'popup')}
        </div>
        <div class="popup-head">
          <div>
            <h3>${escapeHtml(item.name)}</h3>
            <div class="popup-cat">${escapeHtml(item.category)}</div>
          </div>
        </div>
        <p class="popup-note">${escapeHtml(item.note || 'No notes yet.')}</p>
        <div class="popup-actions">
          <a href="${escapeAttr(mapsUrl(item))}" target="_blank" rel="noopener">Directions</a>
          <button type="button" data-popup-edit="${escapeAttr(item.id)}">Edit</button>
        </div>
        ${(item.photoSource || item.photoLink) ? `<div class="popup-credit">${item.photoSource ? 'Photo: ' + escapeHtml(item.photoSource) : ''}${item.photoLink ? ` • <a href="${escapeAttr(item.photoLink)}" target="_blank" rel="noopener">source</a>` : ''}</div>` : ''}
      </div>
    `;
  }

  function escapeHtml(s='') {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function escapeAttr(s='') { return escapeHtml(String(s)); }

  function renderMarkers() {
    markerLayer.clearLayers();
    markers.clear();
    items.filter(visible).filter(x => Number.isFinite(x.lat) && Number.isFinite(x.lng)).forEach(item => {
      const m = L.marker([item.lat,item.lng], {icon:markerIcon(item)}).addTo(markerLayer);
      m.bindPopup(popupHtml(item));
      m.on('popupopen', () => {
        m.setPopupContent(popupHtml(item));
        schedulePhoto(item);
        setTimeout(bindPopupEditButtons, 0);
      });
      markers.set(item.id,m);
      schedulePhoto(item);
    });
  }

  function bindPopupEditButtons() {
    $$('[data-popup-edit]').forEach(btn => {
      btn.onclick = () => {
        const item = items.find(x => x.id === btn.dataset.popupEdit);
        if (item) openEdit(item);
      };
    });
  }

  function updatePhotoSlots(item) {
    document.querySelectorAll(`[data-photo-id="${CSS.escape(item.id)}"]`).forEach(el => {
      const size = el.dataset.photoSize || 'card';
      el.innerHTML = photoThumb(item, size);
    });
    const marker = markers.get(item.id);
    if (marker) marker.setPopupContent(popupHtml(item));
  }

  function schedulePhoto(item) {
    if (!item || item.category === 'Needs Confirmation') return;
    if (item.photoThumbUrl || item.photoUrl) return;
    if (queuedPhotoIds.has(item.id)) return;
    queuedPhotoIds.add(item.id);
    photoQueue.push(item);
    pumpPhotoQueue();
  }

  async function pumpPhotoQueue() {
    while (photoWorkers < 3 && photoQueue.length) {
      const item = photoQueue.shift();
      photoWorkers++;
      resolvePhoto(item)
        .catch(() => {})
        .finally(() => {
          photoWorkers--;
          pumpPhotoQueue();
        });
    }
  }

  async function resolvePhoto(item) {
    const found = await findPhoto(item);
    if (!found) return;
    const changed = !(item.photoUrl || item.photoThumbUrl);
    item.photoUrl = found.photoUrl || item.photoUrl;
    item.photoThumbUrl = found.photoThumbUrl || item.photoThumbUrl || item.photoUrl;
    item.photoLink = found.photoLink || item.photoLink;
    item.photoSource = found.photoSource || item.photoSource;
    if (changed) {
      localSave();
      updatePhotoSlots(item);
      if (storageMode === 'shared' && localStorage.getItem(EDIT_KEY_STORAGE)) {
        queueSave();
      } else {
        render();
      }
    }
  }

  async function findPhoto(item) {
    if (item.photoUrl || item.photoThumbUrl) return null;

    if (item.wikiTitle) {
      const byTitle = await fetchWikiSummary(item.wikiTitle);
      if (byTitle) return byTitle;
    }

    const query = item.imageQuery || `${item.name} Bali`;
    const bySearch = await searchWikipedia(query);
    if (bySearch) return bySearch;

    return null;
  }

  async function fetchWikiSummary(title) {
    try {
      const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
      const res = await fetch(url, { headers: { 'Accept':'application/json' } });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || !data.thumbnail?.source) return null;
      return {
        photoThumbUrl: data.thumbnail.source,
        photoUrl: data.originalimage?.source || data.thumbnail.source,
        photoLink: data.content_urls?.desktop?.page || '',
        photoSource: 'Wikipedia'
      };
    } catch (_) {
      return null;
    }
  }

  async function searchWikipedia(query) {
    try {
      const url = 'https://en.wikipedia.org/w/api.php?origin=*&format=json&action=query&generator=search&gsrsearch='
        + encodeURIComponent(query)
        + '&gsrlimit=1&prop=pageimages|info&inprop=url&pithumbsize=900';
      const res = await fetch(url, { headers: { 'Accept':'application/json' } });
      if (!res.ok) return null;
      const data = await res.json();
      const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
      const page = pages[0];
      if (!page || !page.thumbnail?.source) return null;
      return {
        photoThumbUrl: page.thumbnail.source,
        photoUrl: page.thumbnail.source,
        photoLink: page.fullurl || '',
        photoSource: 'Wikipedia search'
      };
    } catch (_) {
      return null;
    }
  }

  function focusItem(item) {
    switchView('map');
    if (Number.isFinite(item.lat) && Number.isFinite(item.lng)) {
      map.setView([item.lat,item.lng], 15);
      const marker = markers.get(item.id);
      if (marker) {
        marker.setPopupContent(popupHtml(item));
        marker.openPopup();
        setTimeout(bindPopupEditButtons, 0);
      }
    } else {
      window.open(mapsUrl(item), '_blank', 'noopener');
    }
  }

  function switchView(view) {
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
    $('#mapView').classList.toggle('active', view === 'map');
    $('#listView').classList.toggle('active', view === 'list');
    if (view === 'map') setTimeout(() => map.invalidateSize(), 80);
  }

  function openEdit(item) {
    editItemId = item.id;
    $('#editTitle').textContent = item.name;
    $('#editNoteText').value = item.note || '';
    $('#editPhotoUrl').value = item.photoUrl || '';
    $('#editDialog').showModal();
  }

  async function geocodeMissing() {
    const missing = items.filter(x => x.category !== 'Needs Confirmation' && !Number.isFinite(x.lat) && !Number.isFinite(x.lng) && x.query);
    if (!missing.length) return;
    geoStop = false;
    $('#geoBanner').classList.remove('hidden');
    for (let i=0; i<missing.length; i++) {
      if (geoStop) break;
      const item = missing[i];
      $('#geoText').textContent = `Loading map pins • ${i+1}/${missing.length}`;
      const cacheKey = 'bali-geocode:' + item.query;
      let point = null;
      try { point = JSON.parse(localStorage.getItem(cacheKey)); } catch (_) {}
      if (!point) {
        try {
          const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=id&q=' + encodeURIComponent(item.query);
          const res = await fetch(url, {headers:{'Accept':'application/json'}});
          if (res.ok) {
            const result = await res.json();
            if (result.length) {
              point = {lat:Number(result[0].lat), lng:Number(result[0].lon)};
              localStorage.setItem(cacheKey, JSON.stringify(point));
            }
          }
        } catch (_) {}
        await sleep(1100);
      }
      if (point && Number.isFinite(point.lat) && Number.isFinite(point.lng)) {
        item.lat = point.lat; item.lng = point.lng;
        localSave();
        renderMarkers();
      }
    }
    $('#geoBanner').classList.add('hidden');
    if (!geoStop && storageMode === 'shared' && localStorage.getItem(EDIT_KEY_STORAGE)) {
      await saveState();
    }
    const pinned = items.filter(x => Number.isFinite(x.lat) && Number.isFinite(x.lng));
    if (pinned.length > 2) {
      const bounds = L.latLngBounds(pinned.map(x => [x.lat,x.lng]));
      map.fitBounds(bounds.pad(.08));
    }
  }

  function sleep(ms){ return new Promise(r => setTimeout(r,ms)); }

  function bindUI() {
    $$('.tab').forEach(t => t.onclick = () => switchView(t.dataset.view));
    $('#searchInput').addEventListener('input', e => { search = e.target.value; render(); });
    $('#addBtn').onclick = () => $('#addDialog').showModal();
    $('#stopGeo').onclick = () => { geoStop = true; $('#geoBanner').classList.add('hidden'); };

    $('#saveAddBtn').onclick = async (e) => {
      e.preventDefault();
      const form = $('#addForm');
      if (!form.reportValidity()) return;
      const fd = new FormData(form);
      const name = String(fd.get('name') || '').trim();
      const photoUrl = String(fd.get('photoUrl') || '').trim();
      const item = normalizeItem({
        id:'custom-' + Date.now(),
        name,
        category:String(fd.get('category') || 'Sites'),
        query:String(fd.get('query') || '').trim() || `${name}, Bali, Indonesia`,
        note:String(fd.get('note') || '').trim(),
        done:false,
        lat:null,
        lng:null,
        custom:true,
        photoUrl,
        photoThumbUrl: photoUrl,
        imageQuery: `${name} Bali`
      });
      items.push(item);
      queueSave();
      form.reset();
      $('#addDialog').close();
      render();
      if (!photoUrl) schedulePhoto(item);
      geocodeMissing();
    };

    $('#saveEditBtn').onclick = (e) => {
      e.preventDefault();
      const item = items.find(x => x.id === editItemId);
      if (item) {
        item.note = $('#editNoteText').value.trim();
        const customUrl = $('#editPhotoUrl').value.trim();
        item.photoUrl = customUrl;
        item.photoThumbUrl = customUrl;
        if (customUrl) {
          item.photoSource = 'Custom';
          item.photoLink = customUrl;
        } else {
          item.photoSource = '';
          item.photoLink = '';
          schedulePhoto(item);
        }
        queueSave();
        updatePhotoSlots(item);
      }
      $('#editDialog').close();
      render();
    };

    $('#shareBtn').onclick = async () => {
      const payload = {title:'Bali Trip Board', text:'Our Bali trip map + checklist', url:location.href};
      try {
        if (navigator.share) await navigator.share(payload);
        else {
          await navigator.clipboard.writeText(location.href);
          alert('Trip link copied.');
        }
      } catch (_) {}
    };

    $('#unlockBtn').onclick = async () => {
      if (!sharedAvailable) {
        alert('Shared sync is not configured yet. This version is still saving on this device.');
        return;
      }
      localStorage.removeItem(EDIT_KEY_STORAGE);
      const key = await ensureEditKey();
      if (key) {
        $('#unlockBtn').textContent = 'Unlocked';
        await saveState();
      }
    };
  }

  async function init() {
    setupMap();
    bindUI();
    await loadState();
    if (localStorage.getItem(EDIT_KEY_STORAGE)) $('#unlockBtn').textContent = 'Unlocked';
    render();
    geocodeMissing();
    setTimeout(() => items.filter(visible).slice(0, 18).forEach(schedulePhoto), 200);
  }

  init();
})();
