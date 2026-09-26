const VERSION = '8';

class UnifiEventsCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._interval = null;
    this._ageTimer = null;
    this._fetchSeq = 0;
    this._cells = [];          // [{img, placeholder, label, ...}] — built once, patched on each fetch
    this._lightboxCells = [];
    this._onKeyDown = (e) => {
      if (e.key === 'Escape') this._closeLightbox();
    };
  }

  setConfig(config) {
    if (!config.url) throw new Error('You must define a url');
    this._config = config;
    this._build();
  }

  set hass(h) {
    const entity = this._config?.entity;
    if (entity) {
      const prev = this._hass?.states[entity]?.state;
      const next = h.states[entity]?.state;
      if (next && next !== prev) this._fetchAndUpdate('state update');
    }
    this._hass = h;
  }

  _typeIcon(type) {
    const icons = {
      person: '<svg viewBox="0 0 24 24" fill="#555"><circle cx="12" cy="7" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>',
      vehicle: '<svg viewBox="0 0 24 24" fill="#555"><rect x="2" y="10" width="20" height="8" rx="2"/><path d="M5 10l3-5h8l3 5"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></svg>',
      animal: '<svg viewBox="0 0 24 24" fill="#555"><ellipse cx="12" cy="13" rx="5" ry="4"/><circle cx="7" cy="8" r="2"/><circle cx="17" cy="8" r="2"/><circle cx="5" cy="13" r="1.5"/><circle cx="19" cy="13" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>',
      package: '<svg viewBox="0 0 24 24" fill="#555"><rect x="3" y="8" width="18" height="13" rx="1"/><path d="M3 8l3-5h12l3 5"/><line x1="12" y1="8" x2="12" y2="21" stroke="#333" stroke-width="1.5"/></svg>',
    };
    return icons[type] || '<svg viewBox="0 0 24 24" fill="#555"><circle cx="12" cy="12" r="9"/></svg>';
  }

  _fuzzyAge(isoTs) {
    const seconds = Math.floor((Date.now() - new Date(isoTs)) / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(seconds / 86400);
    if (seconds < 60) return 'now';
    if (minutes < 60) return `${minutes} m`;
    if (hours < 24) return `${hours} h`;
    if (days < 7) return `${days} d`;
    return `${Math.floor(days / 7)} w`;
  }

  // Wall-clock stamp for the lightbox pill, e.g. "Tue - 1:11 PM". Anything older
  // than a week gets a date instead of a weekday, which would be ambiguous.
  // hour12 is pinned so the pill stays 12-hour regardless of browser locale.
  _absTime(isoTs) {
    const d = new Date(isoTs);
    if (isNaN(d)) return '';
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
    const day = (Date.now() - d) < 7 * 86400000
      ? d.toLocaleDateString([], { weekday: 'short' })
      : d.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
    return `${day} - ${time}`;
  }

  _build() {
    const cols = this._config.cols || 3;
    const count = this._config.count || 3;
    const lightboxCount = this._config.lightbox_count || 6;

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }

        .card {
          position: relative;
          width: 100%;
          border-radius: var(--ha-card-border-radius, 12px);
          overflow: hidden;
          background: #000;
          box-shadow: var(--ha-card-box-shadow, none);
          cursor: zoom-in;
        }

        .grid {
          display: grid;
          grid-template-columns: repeat(${cols}, 1fr);
          gap: 4px;
        }

        .cell {
          position: relative;
          aspect-ratio: 1 / 1;
          background: #111;
          overflow: hidden;
        }

        .cell img {
          display: block;
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .placeholder {
          display: none;
          width: 100%;
          height: 100%;
          align-items: center;
          justify-content: center;
          background: #1a1a1a;
        }

        .placeholder svg {
          width: 48px;
          height: 48px;
        }

        .cell .label {
          position: absolute;
          bottom: 6px;
          left: 6px;
          background: rgba(0, 0, 0, 0.65);
          color: #fff;
          font-size: 13px;
          font-family: sans-serif;
          padding: 2px 6px;
          border-radius: 4px;
          pointer-events: none;
        }

        /* Lightbox only: a second pill in the opposite corner with the wall-clock time. */
        .cell .label.time {
          left: auto;
          right: 6px;
        }

        .lightbox {
          display: none;
          position: fixed;
          inset: 0;
          z-index: 9999;
          background: rgba(0, 0, 0, 0.92);
          align-items: center;
          justify-content: center;
          cursor: zoom-out;
        }
        .lightbox.open { display: flex; }

        .lightbox-inner {
          overflow: hidden;
        }

        .lightbox .grid {
          grid-template-columns: repeat(${cols}, 1fr);
        }

        .lightbox .cell {
          aspect-ratio: 1 / 1;
        }

        .close-btn {
          position: fixed;
          top: 16px;
          right: 20px;
          color: #fff;
          font-size: 32px;
          line-height: 1;
          cursor: pointer;
          opacity: 0.7;
          font-family: sans-serif;
          user-select: none;
          z-index: 10000;
        }
        .close-btn:hover { opacity: 1; }

        .version {
          position: absolute;
          top: 4px;
          left: 6px;
          color: #ededed;
          text-shadow: 0px 1px 2px #000000;
          font-size: 16px;
          font-weight: bold;
          font-family: monospace;
          pointer-events: none;
        }
      </style>

      <div class="card" id="card">
        <div class="grid" id="grid"></div>
        ${this._config.show_version ? `<span class="version">v${VERSION}</span>` : ''}
      </div>

      <div class="lightbox" id="lightbox">
        <span class="close-btn" id="close-btn">&times;</span>
        <div class="lightbox-inner">
          <div class="grid" id="lightbox-grid"></div>
        </div>
      </div>
    `;

    const card = this.shadowRoot.getElementById('card');
    const lightbox = this.shadowRoot.getElementById('lightbox');
    const closeBtn = this.shadowRoot.getElementById('close-btn');
    const grid = this.shadowRoot.getElementById('grid');
    const lightboxGrid = this.shadowRoot.getElementById('lightbox-grid');
    const lightboxInner = this.shadowRoot.querySelector('.lightbox-inner');

    // Fit the lightbox grid within the viewport without scrolling.
    // Cells are square, so grid aspect ratio = cols : rows.
    // Width is capped at whichever limit is hit first: 95vw or the width
    // that makes the full grid height equal 95vh.
    const rows = Math.ceil(lightboxCount / cols);
    lightboxInner.style.width = `min(95vw, calc(95vh * ${cols} / ${rows}))`;

    // Pre-build empty cells. The lightbox is roomier, so its labels also carry
    // the wall-clock time alongside the relative age.
    this._cells = [];
    for (let i = 0; i < count; i++) this._cells.push(this._makeCell(grid, false));

    this._lightboxCells = [];
    for (let i = 0; i < lightboxCount; i++) this._lightboxCells.push(this._makeCell(lightboxGrid, true));

    // Lightbox open/close
    card.addEventListener('click', () => lightbox.classList.add('open'));
    lightbox.addEventListener('click', () => this._closeLightbox());
    closeBtn.addEventListener('click', () => this._closeLightbox());

    this._fetchAndUpdate('initial');
    if (this.isConnected) this._startTimers();
  }

  _makeCell(grid, showAbs) {
    const el = document.createElement('div');
    el.className = 'cell';
    const img = document.createElement('img');
    img.decoding = 'async';
    const placeholder = document.createElement('div');
    placeholder.className = 'placeholder';
    const label = document.createElement('span');
    label.className = 'label';
    el.appendChild(img);
    el.appendChild(placeholder);
    el.appendChild(label);
    let timeLabel = null;
    if (showAbs) {
      timeLabel = document.createElement('span');
      timeLabel.className = 'label time';
      el.appendChild(timeLabel);
    }
    grid.appendChild(el);

    const cell = { el, img, placeholder, label, timeLabel, showAbs, url: null, ts: null, type: null, retries: 0, failed: false };
    img.addEventListener('load', () => this._onImgLoad(cell));
    img.addEventListener('error', () => this._onImgError(cell));
    return cell;
  }

  _closeLightbox() {
    this.shadowRoot.getElementById('lightbox')?.classList.remove('open');
  }

  _fetchAndUpdate(reason = 'interval') {
    const count = this._config.count || 3;
    const lightboxCount = this._config.lightbox_count || 6;
    const url = this._config.url;
    const seq = ++this._fetchSeq;

    console.debug(`[unifi-events-card] fetching (${reason})`, url);
    fetch(`${url}?_t=${Date.now()}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(data => {
        // Ignore a slow response that a newer fetch has already superseded.
        if (seq !== this._fetchSeq) return;
        const thumbs = data.thumbnails || [];
        this._patch(this._cells, thumbs.slice(0, count).reverse());
        this._patch(this._lightboxCells, thumbs.slice(0, lightboxCount).reverse());
      })
      .catch((err) => console.debug('[unifi-events-card] fetch failed', err));
  }

  _patch(cells, thumbs) {
    // Newest goes last. When there are fewer entries than cells, leave the gap at
    // the start so the newest keeps the final slot instead of drifting mid-grid.
    const offset = cells.length - thumbs.length;
    cells.forEach((cell, i) => this._applyThumb(cell, thumbs[i - offset]));
  }

  _applyThumb(cell, thumb) {
    if (!thumb) {
      cell.url = null;
      cell.ts = null;
      cell.type = null;
      cell.img.removeAttribute('src');
      cell.img.style.display = 'none';
      cell.placeholder.style.display = 'none';
      this._renderLabel(cell);
      return;
    }

    cell.ts = thumb.ts;
    cell.type = thumb.type;
    this._renderLabel(cell);

    if (!thumb.url) {
      // Detection seen, thumbnail not generated yet — hold the slot with a typed icon.
      cell.url = null;
      cell.img.removeAttribute('src');
      this._showPlaceholder(cell);
      return;
    }

    if (cell.url !== thumb.url) {
      cell.url = thumb.url;
      cell.retries = 0;
      cell.failed = false;
      // Leave the old image on screen until the new one decodes, to avoid a flash.
      cell.img.src = thumb.url;
    } else if (cell.failed) {
      this._retry(cell);   // same URL as before but it never loaded — try again
    }
  }

  _showPlaceholder(cell) {
    cell.placeholder.innerHTML = this._typeIcon(cell.type);
    cell.placeholder.style.display = 'flex';
    cell.img.style.display = 'none';
  }

  _onImgLoad(cell) {
    cell.failed = false;
    cell.retries = 0;
    cell.placeholder.style.display = 'none';
    cell.img.style.display = 'block';
  }

  _onImgError(cell) {
    if (!cell.url) return;
    cell.failed = true;
    this._showPlaceholder(cell);   // a typed icon beats a broken-image glyph
    if (cell.retries >= 4) {
      console.warn('[unifi-events-card] giving up on', cell.url);
      return;
    }
    const url = cell.url;
    const delay = 1000 * Math.pow(2, cell.retries);
    setTimeout(() => {
      if (cell.url === url) this._retry(cell);
    }, delay);
  }

  _retry(cell) {
    if (!cell.url || cell.retries >= 8) return;
    cell.retries += 1;
    // /local is served with a month-long cache header, so a retry needs a fresh
    // URL or the browser just replays the failed/truncated response.
    const sep = cell.url.includes('?') ? '&' : '?';
    cell.img.src = `${cell.url}${sep}_retry=${cell.retries}`;
  }

  _renderLabel(cell) {
    if (!cell.ts) {
      cell.label.textContent = '';
      cell.label.style.display = 'none';   // otherwise an empty cell shows a bare chip
      if (cell.timeLabel) {
        cell.timeLabel.textContent = '';
        cell.timeLabel.style.display = 'none';
      }
      return;
    }
    cell.label.style.display = '';
    cell.label.textContent = this._fuzzyAge(cell.ts);
    if (cell.timeLabel) {
      cell.timeLabel.style.display = '';
      cell.timeLabel.textContent = this._absTime(cell.ts);
    }
  }

  // Ages are rendered at fetch time, so without this a label reads "now" until the
  // next fetch — which can be minutes.
  _refreshLabels() {
    [...this._cells, ...this._lightboxCells].forEach((cell) => this._renderLabel(cell));
  }

  _startTimers() {
    const refreshInterval = (this._config.refresh_interval || 300) * 1000;
    if (!this._interval) {
      this._interval = setInterval(() => this._fetchAndUpdate('interval'), refreshInterval);
    }
    if (!this._ageTimer) {
      this._ageTimer = setInterval(() => this._refreshLabels(), 30000);
    }
  }

  _stopTimers() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
    if (this._ageTimer) clearInterval(this._ageTimer);
    this._ageTimer = null;
  }

  connectedCallback() {
    // HA moves cards in and out of the DOM while rendering and navigating, which
    // kills the timers — restart them (and refresh) whenever we come back.
    if (!this._config) return;
    document.addEventListener('keydown', this._onKeyDown);
    this._fetchAndUpdate('connected');
    this._startTimers();
  }

  disconnectedCallback() {
    document.removeEventListener('keydown', this._onKeyDown);
    this._stopTimers();
  }

  getCardSize() {
    return 3;
  }
}

customElements.define('unifi-events-card', UnifiEventsCard);
