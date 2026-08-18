
(() => {
  const STORAGE_KEY = 'bali-trip-board-v2';
  const EDIT_KEY_STORAGE = 'bali-trip-edit-key';
  const GOOGLE_RESOLVE_CONCURRENCY = 5;

  const emojis = {
    'Rice Terraces':'🌾','Water Temples':'💧','Temples':'🛕','Waterfalls':'🌊',
    'Sites':'📍','Activities':'🎟️','Spa':'🧖','Food':'🍴','Needs Confirmation':'❓'
  };

  let items = [];
  let storageMode = 'local';
  let sharedAvailable = false;
  let activeFilter = 'All';
  let search = '';
  let map = null;
  let infoWindow = null;
  let AdvancedMarkerElement = null;
  let PlaceClass = null;
  let LatLngBounds = null;
  let editItemId = null;
  let saveTimer = null;
  let googleReadyPromise = null;

  // Google content lives only for this page session. We intentionally do not
  // save photo URIs/photos to localStorage or the shared trip state.
  const placeSession = new Map();
  const locationSession = new Map();
  const photoSession = new Map();
  const markers = new Map();

  let imageObserver = null;

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  function deepCopy(x){ return JSON.parse(JSON.stringify(x)); }

  function normalizeItem(item) {
    const source = String(item.photoSource || '');
    const url = String(item.photoUrl || '');
    const isLegacyAutoPhoto =
      /wikipedia/i.test(source) ||
      /wikimedia|wikipedia/i.test(url);

    return {
      googlePlaceId: '',
      googlePhotoIndex: 0,
      ...item,
      // Strip the old auto-Wikipedia data. Only trip data persists.
      photoUrl: isLegacyAutoPhoto ? '' : (item.photoUrl || ''),
      photoThumbUrl: isLegacyAutoPhoto ? '' : (item.photoThumbUrl || ''),
      photoLink: isLegacyAutoPhoto ? '' : (item.photoLink || ''),
      photoSource: isLegacyAutoPhoto ? '' : (item.photoSource || ''),
      googlePhotoIndex: Number.isInteger(Number(item.googlePhotoIndex))
        ? Math.max(0, Number(item.googlePhotoIndex))
        : 0
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

  function queueSave({automatic=false} = {}) {
    localSave();
    clearTimeout(saveTimer);

    // Automatic Google place-ID resolution must never pop an edit-PIN prompt.
    if (automatic && !localStorage.getItem(EDIT_KEY_STORAGE)) return;

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

  async function loadGoogleMaps() {
    if (googleReadyPromise) return googleReadyPromise;

    googleReadyPromise = (async () => {
      const configRes = await fetch('/api/google-config', { cache:'no-store' });
      if (!configRes.ok) {
        throw new Error('GOOGLE_MAPS_BROWSER_KEY is not configured in Vercel.');
      }
      const { key } = await configRes.json();
      if (!key) throw new Error('Missing Google Maps browser key.');

      await new Promise((resolve, reject) => {
        if (window.google?.maps?.importLibrary) return resolve();

        const callbackName = '__baliTripGoogleMapsReady';
        window[callbackName] = () => {
          delete window[callbackName];
          resolve();
        };

        const script = document.createElement('script');
        script.async = true;
        script.defer = true;
        script.src =
          'https://maps.googleapis.com/maps/api/js'
          + '?key=' + encodeURIComponent(key)
          + '&v=weekly'
          + '&libraries=places,marker'
          + '&loading=async'
          + '&callback=' + callbackName;
        script.onerror = () => reject(new Error('Google Maps JavaScript API failed to load.'));
        document.head.appendChild(script);
      });

      const [{ Map, InfoWindow }, markerLib, placesLib, coreLib] = await Promise.all([
        google.maps.importLibrary('maps'),
        google.maps.importLibrary('marker'),
        google.maps.importLibrary('places'),
        google.maps.importLibrary('core')
      ]);

      AdvancedMarkerElement = markerLib.AdvancedMarkerElement;
      PlaceClass = placesLib.Place;
      LatLngBounds = coreLib.LatLngBounds;

      const mapNode = $('#map');
      mapNode.innerHTML = '';
      map = new Map(mapNode, {
        center: { lat:-8.5069, lng:115.2625 },
        zoom: 9,
        mapId: 'DEMO_MAP_ID',
        streetViewControl: false,
        mapTypeControl: false,
        fullscreenControl: true,
        clickableIcons: true
      });
      infoWindow = new InfoWindow();

      return true;
    })();

    return googleReadyPromise;
  }

  function mapsUrl(item) {
    if (item.googlePlaceId) {
      return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.name)}&query_place_id=${encodeURIComponent(item.googlePlaceId)}`;
    }
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
    updateMarkerVisibility();
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

    observeVisiblePhotos();
  }

  function cardFor(item) {
    const card = document.createElement('article');
    card.className = 'card' + (item.done ? ' done':'');
    card.innerHTML = `
      <input type="checkbox" class="check" ${item.done ? 'checked':''} aria-label="Mark ${escapeAttr(item.name)} done" />

      <button class="thumb-btn" type="button" aria-label="Open ${escapeAttr(item.name)} on the map">
        <div class="thumb-shell" data-photo-slot="${escapeAttr(item.id)}">
          ${photoSlotMarkup(item)}
        </div>
      </button>

      <div class="card-main">
        <div class="place-name">${escapeHtml(item.name)}</div>
        <div class="place-note">${escapeHtml(item.note || 'No notes yet.')}</div>
        <div class="badge-row">
          <span class="badge">${escapeHtml(item.category)}</span>
          ${item.category !== 'Needs Confirmation' ? `<span class="badge google-badge">Google photo</span>` : ''}
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

    return card;
  }

  function photoSlotMarkup(item) {
    if (item.category === 'Needs Confirmation') {
      return `<div class="thumb-fallback">${emojis[item.category] || '❓'}</div>
              <div class="photo-error">Location needs confirmation</div>`;
    }

    const p = photoSession.get(item.id);
    if (p?.url) {
      return `
        <img class="thumb-img" src="${escapeAttr(p.url)}" alt="${escapeAttr(item.name)}" loading="lazy" decoding="async" />
        <div class="google-maps-attribution" translate="no">Google Maps</div>
      `;
    }

    if (p?.error) {
      return `
        <div class="thumb-fallback">${emojis[item.category] || '📍'}</div>
        <div class="photo-error">Google photo unavailable</div>
      `;
    }

    return `
      <div class="thumb-fallback">${emojis[item.category] || '📍'}</div>
      <div class="thumb-loading" aria-hidden="true"></div>
      <div class="google-maps-attribution" translate="no">Google Maps</div>
    `;
  }

  function observeVisiblePhotos() {
    if (imageObserver) imageObserver.disconnect();

    imageObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const slot = entry.target;
        const item = items.find(x => x.id === slot.dataset.photoSlot);
        if (item) resolvePhoto(item);
        imageObserver.unobserve(slot);
      });
    }, {
      root: window.innerWidth >= 900 ? $('#list') : null,
      rootMargin: '320px 0px',
      threshold: 0.01
    });

    $$('[data-photo-slot]').forEach(slot => imageObserver.observe(slot));
  }

  async function resolvePhoto(item, {force=false} = {}) {
    if (!item || item.category === 'Needs Confirmation') return null;
    if (!force && photoSession.has(item.id)) return photoSession.get(item.id);

    try {
      const place = await resolvePlace(item);
      if (!place) throw new Error('Place not found.');

      // Fresh Places photo data for this page session.
      await place.fetchFields({ fields:['photos','googleMapsURI'] });

      const photos = place.photos || [];
      if (!photos.length) throw new Error('No Google Places photos.');

      const index = Math.max(0, Number(item.googlePhotoIndex || 0)) % photos.length;
      const photo = photos[index];
      const url = photo.getURI({ maxWidth: 720, maxHeight: 540 });

      const author = photo.authorAttributions?.[0] || null;
      const result = {
        url,
        photoCount: photos.length,
        index,
        photoGoogleMapsURI: photo.googleMapsURI || place.googleMapsURI || mapsUrl(item),
        author: author ? {
          displayName: author.displayName || '',
          uri: author.uri || '',
          photoURI: author.photoURI || ''
        } : null
      };

      photoSession.set(item.id, result);
      updatePhotoSlots(item);
      refreshOpenInfo(item);
      return result;
    } catch (err) {
      const result = { error: err?.message || 'Photo unavailable.' };
      photoSession.set(item.id, result);
      updatePhotoSlots(item);
      return result;
    }
  }

  function updatePhotoSlots(item) {
    document.querySelectorAll(`[data-photo-slot="${cssEscape(item.id)}"]`).forEach(slot => {
      slot.innerHTML = photoSlotMarkup(item);
    });
  }

  async function resolvePlace(item) {
    if (!item || item.category === 'Needs Confirmation') return null;
    if (placeSession.has(item.id)) return placeSession.get(item.id);

    await loadGoogleMaps();

    let place = null;

    // Once we have a Google Place ID, use it directly. Google permits Place IDs
    // to be stored and reused, and this avoids fuzzy searches on later visits.
    if (item.googlePlaceId) {
      try {
        place = new PlaceClass({ id:item.googlePlaceId });
        await place.fetchFields({ fields:['id','displayName','location'] });
      } catch (_) {
        place = null;
        item.googlePlaceId = '';
        queueSave({automatic:true});
      }
    }

    if (!place) {
      const request = {
        textQuery: item.query || `${item.name}, Bali, Indonesia`,
        fields: ['id','displayName','location'],
        maxResultCount: 4,
        language: 'en',
        region: 'id'
      };

      const { places } = await PlaceClass.searchByText(request);
      if (!places?.length) return null;

      place = chooseBestGooglePlace(item, places);

      if (place?.id && item.googlePlaceId !== place.id) {
        item.googlePlaceId = place.id;
        queueSave({automatic:true});
      }
    }

    if (!place) return null;

    placeSession.set(item.id, place);

    if (place.location) {
      const lat = typeof place.location.lat === 'function' ? place.location.lat() : place.location.lat;
      const lng = typeof place.location.lng === 'function' ? place.location.lng() : place.location.lng;
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        locationSession.set(item.id, {lat,lng});
        addOrUpdateMarker(item);
      }
    }

    return place;
  }

  function chooseBestGooglePlace(item, places) {
    const target = normalizeWords((item.query || item.name).split(',')[0]);
    const targetTokens = new Set(target.split(' ').filter(Boolean));

    let best = places[0];
    let bestScore = -Infinity;

    places.forEach(place => {
      const name = normalizeWords(place.displayName || '');
      const tokens = new Set(name.split(' ').filter(Boolean));

      let overlap = 0;
      targetTokens.forEach(t => { if (tokens.has(t)) overlap++; });

      const union = new Set([...targetTokens, ...tokens]).size || 1;
      const jaccard = overlap / union;
      const containsBonus =
        name.includes(target) || target.includes(name) ? 2.5 : 0;

      const score = jaccard * 5 + containsBonus;
      if (score > bestScore) {
        bestScore = score;
        best = place;
      }
    });

    return best;
  }

  function normalizeWords(value='') {
    return String(value)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g,'')
      .replace(/[^a-z0-9 ]+/g,' ')
      .replace(/\b(bali|indonesia|the|pura)\b/g,' ')
      .replace(/\s+/g,' ')
      .trim();
  }

  function makeMarkerContent(item) {
    const el = document.createElement('div');
    el.className = 'trip-marker' + (item.done ? ' done':'');
    el.textContent = emojis[item.category] || '📍';
    el.title = item.name;
    return el;
  }

  function addOrUpdateMarker(item) {
    if (!map || !AdvancedMarkerElement) return;
    const pos = locationSession.get(item.id) ||
      (Number.isFinite(item.lat) && Number.isFinite(item.lng) ? {lat:item.lat,lng:item.lng} : null);
    if (!pos) return;

    const old = markers.get(item.id);
    if (old) old.map = null;

    const marker = new AdvancedMarkerElement({
      map: visible(item) ? map : null,
      position: pos,
      title: item.name,
      content: makeMarkerContent(item)
    });

    marker.addListener('click', () => openInfo(item, marker));
    markers.set(item.id, marker);
  }

  function updateMarkerVisibility() {
    if (!map) return;

    items.forEach(item => {
      const marker = markers.get(item.id);
      if (marker) {
        marker.map = visible(item) ? map : null;
        return;
      }

      // Existing OSM/Nominatim coordinates from older versions can be shown
      // immediately while Google resolves the exact Place in the background.
      if (Number.isFinite(item.lat) && Number.isFinite(item.lng)) {
        addOrUpdateMarker(item);
      }
    });
  }

  async function openInfo(item, marker) {
    if (!infoWindow) return;

    infoWindow.setContent(infoHtml(item));
    infoWindow.open({ map, anchor:marker });

    const place = await resolvePlace(item);
    await resolvePhoto(item);

    // place may have updated/confirmed the marker.
    const currentMarker = markers.get(item.id) || marker;
    infoWindow.setContent(infoHtml(item));
    infoWindow.open({ map, anchor:currentMarker });

    setTimeout(bindInfoButtons, 0);
  }

  function refreshOpenInfo(item) {
    if (!infoWindow?.getMap?.()) return;
    const marker = markers.get(item.id);
    if (!marker) return;
    infoWindow.setContent(infoHtml(item));
    setTimeout(bindInfoButtons, 0);
  }

  function infoHtml(item) {
    const p = photoSession.get(item.id);
    const image = p?.url
      ? `<img src="${escapeAttr(p.url)}" alt="${escapeAttr(item.name)}" decoding="async" />`
      : `<div class="thumb-fallback">${emojis[item.category] || '📍'}</div>`;

    let author = '';
    if (p?.author?.displayName) {
      const avatar = p.author.photoURI
        ? `<img src="${escapeAttr(p.author.photoURI)}" alt="" />`
        : '';
      const name = p.author.uri
        ? `<a href="${escapeAttr(p.author.uri)}" target="_blank" rel="noopener">${escapeHtml(p.author.displayName)}</a>`
        : escapeHtml(p.author.displayName);

      author = `<div class="author-attribution">${avatar}<span>Photo by ${name}</span></div>`;
    }

    return `
      <div class="info-card">
        <div class="info-photo">
          ${image}
          <div class="google-maps-attribution" translate="no">Google Maps</div>
        </div>
        <h3>${escapeHtml(item.name)}</h3>
        <div class="info-cat">${escapeHtml(item.category)}</div>
        <div class="info-note">${escapeHtml(item.note || 'No notes yet.')}</div>

        <div class="info-actions">
          <a href="${escapeAttr(mapsUrl(item))}" target="_blank" rel="noopener">Directions</a>
          ${p?.photoCount > 1 ? `<button type="button" data-next-photo="${escapeAttr(item.id)}">Next Google photo</button>` : ''}
          <button type="button" data-info-edit="${escapeAttr(item.id)}">Edit note</button>
        </div>

        ${author}

        ${p?.photoGoogleMapsURI ? `
          <div class="source-line">
            <a href="${escapeAttr(p.photoGoogleMapsURI)}" target="_blank" rel="noopener">View this photo on Google Maps</a>
          </div>` : ''}
      </div>
    `;
  }

  function bindInfoButtons() {
    $$('[data-info-edit]').forEach(btn => {
      btn.onclick = () => {
        const item = items.find(x => x.id === btn.dataset.infoEdit);
        if (item) openEdit(item);
      };
    });

    $$('[data-next-photo]').forEach(btn => {
      btn.onclick = async () => {
        const item = items.find(x => x.id === btn.dataset.nextPhoto);
        if (!item) return;

        const p = photoSession.get(item.id);
        const count = p?.photoCount || 10;
        item.googlePhotoIndex = (Number(item.googlePhotoIndex || 0) + 1) % count;
        photoSession.delete(item.id);
        queueSave();

        infoWindow.setContent(infoHtml(item));
        await resolvePhoto(item, {force:true});
        infoWindow.setContent(infoHtml(item));
        setTimeout(bindInfoButtons, 0);
      };
    });
  }

  async function resolveAllPlaces() {
    await loadGoogleMaps();

    const queue = items.filter(x => x.category !== 'Needs Confirmation');
    let completed = 0;
    let resolved = 0;
    const total = queue.length;

    $('#geoBanner').classList.remove('hidden');

    const worker = async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          const place = await resolvePlace(item);
          if (place) resolved++;
        } catch (_) {}
        completed++;
        $('#geoText').textContent = `Google places • ${completed}/${total}`;
      }
    };

    await Promise.all(
      Array.from({length:Math.min(GOOGLE_RESOLVE_CONCURRENCY,total)}, () => worker())
    );

    $('#geoBanner').classList.add('hidden');

    const positions = items
      .filter(x => x.category !== 'Needs Confirmation')
      .map(x => locationSession.get(x.id) ||
        (Number.isFinite(x.lat) && Number.isFinite(x.lng) ? {lat:x.lat,lng:x.lng} : null))
      .filter(Boolean);

    if (positions.length > 2 && LatLngBounds) {
      const bounds = new LatLngBounds();
      positions.forEach(p => bounds.extend(p));
      map.fitBounds(bounds, 35);
    }
  }

  async function focusItem(item) {
    switchView('map');

    if (item.category === 'Needs Confirmation') {
      alert(`${item.name} is still marked Needs Confirmation, so the app will not guess a Google location for it.`);
      return;
    }

    try {
      await loadGoogleMaps();
      await resolvePlace(item);

      const pos = locationSession.get(item.id) ||
        (Number.isFinite(item.lat) && Number.isFinite(item.lng) ? {lat:item.lat,lng:item.lng} : null);

      if (!pos) {
        window.open(mapsUrl(item), '_blank', 'noopener');
        return;
      }

      map.panTo(pos);
      map.setZoom(15);

      const marker = markers.get(item.id);
      if (marker) await openInfo(item, marker);
    } catch (_) {
      window.open(mapsUrl(item), '_blank', 'noopener');
    }
  }

  function switchView(view) {
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
    $('#mapView').classList.toggle('active', view === 'map');
    $('#listView').classList.toggle('active', view === 'list');

    if (view === 'map' && map) {
      setTimeout(() => google.maps.event.trigger(map,'resize'), 80);
    }
  }

  function openEdit(item) {
    editItemId = item.id;
    $('#editTitle').textContent = item.name;
    $('#editNoteText').value = item.note || '';
    $('#editDialog').showModal();
  }

  function escapeHtml(s='') {
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  function escapeAttr(s='') { return escapeHtml(String(s)); }

  function cssEscape(value='') {
    if (window.CSS?.escape) return CSS.escape(String(value));
    return String(value).replace(/["\\]/g,'\\$&');
  }

  function bindUI() {
    $$('.tab').forEach(t => t.onclick = () => switchView(t.dataset.view));

    $('#searchInput').addEventListener('input', e => {
      search = e.target.value;
      render();
    });

    $('#addBtn').onclick = () => $('#addDialog').showModal();

    $('#saveAddBtn').onclick = async (e) => {
      e.preventDefault();
      const form = $('#addForm');
      if (!form.reportValidity()) return;

      const fd = new FormData(form);
      const name = String(fd.get('name') || '').trim();

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
        googlePlaceId:'',
        googlePhotoIndex:0
      });

      items.push(item);
      queueSave();
      form.reset();
      $('#addDialog').close();
      render();

      try {
        await loadGoogleMaps();
        await resolvePlace(item);
      } catch (_) {}
    };

    $('#saveEditBtn').onclick = (e) => {
      e.preventDefault();
      const item = items.find(x => x.id === editItemId);
      if (item) {
        item.note = $('#editNoteText').value.trim();
        queueSave();
      }
      $('#editDialog').close();
      render();
    };

    $('#shareBtn').onclick = async () => {
      const payload = {
        title:'Bali Trip Board',
        text:'Our Bali trip map + checklist',
        url:location.href
      };
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
    bindUI();
    await loadState();

    if (localStorage.getItem(EDIT_KEY_STORAGE)) {
      $('#unlockBtn').textContent = 'Unlocked';
    }

    // Render the useful trip list immediately. Google Maps and Google Places
    // initialize after the interface is already usable.
    render();

    try {
      await loadGoogleMaps();
      updateMarkerVisibility();
      resolveAllPlaces();
    } catch (err) {
      $('#map').innerHTML = `
        <div class="map-loading">
          <strong>Google Maps is not configured yet.</strong>
          <span>${escapeHtml(err?.message || 'Add GOOGLE_MAPS_BROWSER_KEY in Vercel and redeploy.')}</span>
        </div>
      `;
      $('#geoBanner').classList.add('hidden');
    }
  }

  init();
})();
