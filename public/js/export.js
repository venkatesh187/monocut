/**
 * MonoCut - Supercharged High-Speed Export Studio
 * Features:
 * - ⚡ God Speed Lossless Stream Copy (~0.2s - 1s instant render, 0% CPU strain, 100% bitstream purity)
 * - 🚀 Universal Fast MP4 (Maximum compute parallel multi-threading, ultrafast encode)
 * - 📱 YouTube Shorts & Reels (Dedicated 9:16 vertical 1080×1920 @ 60 FPS preset)
 * - Clean & Simple configuration: Essential presets, resolution, format, and optional custom filename
 * - Live real-time progress meter with speed and time remaining
 */

class ExportManager {
  constructor(player, timeline) {
    this.player = player;
    this.timeline = timeline;

    this.exportModal = document.getElementById('exportModal');
    this.btnOpenExport = document.getElementById('btnOpenExport');
    this.btnCloseExportModal = document.getElementById('btnCloseExportModal');
    this.btnDismissExport = document.getElementById('btnDismissExport');
    this.btnExecuteExport = document.getElementById('btnExecuteExport');

    this.exportSetupSection = document.getElementById('exportSetupSection');
    this.exportProgressSection = document.getElementById('exportProgressSection');
    this.exportSuccessBox = document.getElementById('exportSuccessBox');

    // Header Stats
    this.exportAspectVal = document.getElementById('exportAspectVal');
    this.exportClipsVal = document.getElementById('exportClipsVal');
    this.exportLengthVal = document.getElementById('exportLengthVal');
    this.exportEstSizeVal = document.getElementById('exportEstSizeVal');
    this.exportSourceSpecVal = document.getElementById('exportSourceSpecVal');

    // Preset Cards
    this.cardGodSpeed = document.getElementById('cardGodSpeed');
    this.cardUniversalMp4 = document.getElementById('cardUniversalMp4');
    this.cardShorts60fps = document.getElementById('cardShorts60fps');

    // Contextual Controls & Selectors
    this.lockedSettingsNote = document.getElementById('lockedSettingsNote');
    this.lockedNoteText = document.getElementById('lockedNoteText');
    this.advancedDropdownsGrid = document.getElementById('advancedDropdownsGrid');
    this.exportResolutionSelect = document.getElementById('exportResolutionSelect');
    this.exportFormatSelect = document.getElementById('exportFormatSelect');
    this.exportCustomFileName = document.getElementById('exportCustomFileName');
    this.exportExtBadge = document.getElementById('exportExtBadge');

    // Progress Elements
    this.exportStageText = document.getElementById('exportStageText');
    this.exportPercentageText = document.getElementById('exportPercentageText');
    this.exportMeterBar = document.getElementById('exportMeterBar');
    this.exportSpeedMetric = document.getElementById('exportSpeedMetric');
    this.exportTimeLeftMetric = document.getElementById('exportTimeLeftMetric');
    this.btnCancelActiveExport = document.getElementById('btnCancelActiveExport');

    // Completion Elements
    this.finishedFileName = document.getElementById('finishedFileName');
    this.btnDownloadFinished = document.getElementById('btnDownloadFinished');
    this.btnRevealInFolder = document.getElementById('btnRevealInFolder');
    this.btnFinishExport = document.getElementById('btnFinishExport');

    this.currentSourcePath = null;
    this.meta = null;
    this.activeSse = null;
    this.pollTimer = null;
    this.lastExportedFile = null;
    this.currentJobId = null;

    this.initEvents();
  }

  initEvents() {
    if (this.btnOpenExport) this.btnOpenExport.addEventListener('click', () => this.showModal());
    if (this.btnCloseExportModal) this.btnCloseExportModal.addEventListener('click', () => this.hideModal());
    if (this.btnDismissExport) this.btnDismissExport.addEventListener('click', () => this.hideModal());
    if (this.btnFinishExport) this.btnFinishExport.addEventListener('click', () => this.hideModal());

    if (this.btnCancelActiveExport) {
      this.btnCancelActiveExport.addEventListener('click', async () => {
        if (!this.currentJobId) return;
        if (!confirm('Cancel the current video export?')) return;
        try {
          await fetch(`/api/export/${this.currentJobId}`, { method: 'DELETE' });
        } catch (e) {}
        if (this.activeSse) { this.activeSse.close(); this.activeSse = null; }
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
        this.currentJobId = null;
        this.exportSetupSection.style.display = 'flex';
        this.exportProgressSection.style.display = 'none';
      });
    }

    // Export Mode Radio Cards
    const cards = [
      { el: this.cardGodSpeed, val: 'godspeed' },
      { el: this.cardUniversalMp4, val: 'mp4-fast' },
      { el: this.cardShorts60fps, val: 'shorts-60fps' }
    ];

    cards.forEach(cardObj => {
      if (!cardObj.el) return;
      cardObj.el.addEventListener('click', () => {
        cards.forEach(c => {
          if (c.el) {
            c.el.classList.remove('active');
            const inp = c.el.querySelector('input');
            if (inp) inp.checked = false;
          }
        });
        cardObj.el.classList.add('active');
        const inp = cardObj.el.querySelector('input');
        if (inp) inp.checked = true;

        this.applyPresetValues(cardObj.val);
        this.updateEnginePreview();
      });
    });

    // Listen to changes on essential selectors to update the live engine badge
    if (this.exportFormatSelect) {
      this.exportFormatSelect.addEventListener('change', () => this.updateEnginePreview());
    }
    if (this.exportResolutionSelect) {
      this.exportResolutionSelect.addEventListener('change', () => this.updateEnginePreview());
    }

    if (this.btnExecuteExport) {
      this.btnExecuteExport.addEventListener('click', () => this.startExport());
    }

    if (this.btnRevealInFolder) {
      this.btnRevealInFolder.addEventListener('click', () => {
        fetch('/api/open-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: this.lastExportedFile })
        });
      });
    }
  }

  applyPresetValues(presetName) {
    const isWebm = (this.currentSourcePath && this.currentSourcePath.toLowerCase().endsWith('.webm')) ||
                   (this.meta && (this.meta.videoCodec === 'vp9' || this.meta.videoCodec === 'vp8'));

    if (presetName === 'godspeed') {
      if (this.exportResolutionSelect) this.exportResolutionSelect.value = 'source';
      if (this.exportFormatSelect) this.exportFormatSelect.value = isWebm ? 'webm' : 'mp4';
    } else if (presetName === 'mp4-fast') {
      if (this.exportResolutionSelect) this.exportResolutionSelect.value = 'source';
      if (this.exportFormatSelect) this.exportFormatSelect.value = 'mp4';
    } else if (presetName === 'shorts-60fps') {
      if (this.exportResolutionSelect) this.exportResolutionSelect.value = '1080p';
      if (this.exportFormatSelect) this.exportFormatSelect.value = 'mp4';
    }
  }

  updateEnginePreview() {
    const modeInput = document.querySelector('input[name="exportMode"]:checked');
    const selectedMode = modeInput ? modeInput.value : 'godspeed';

    const isWebm = (this.currentSourcePath && this.currentSourcePath.toLowerCase().endsWith('.webm')) ||
                   (this.meta && (this.meta.videoCodec === 'vp9' || this.meta.videoCodec === 'vp8'));

    // Progressive Disclosure for Output Controls
    if (selectedMode === 'godspeed') {
      if (this.advancedDropdownsGrid) this.advancedDropdownsGrid.style.display = 'none';
      if (this.lockedSettingsNote) this.lockedSettingsNote.style.display = 'flex';
      if (this.lockedNoteText) {
        const sourceLabel = isWebm ? '4K WebM' : '4K MP4';
        this.lockedNoteText.textContent = `Resolution & format locked to source (${sourceLabel}) for instant stream copy.`;
      }
      if (this.exportResolutionSelect) this.exportResolutionSelect.value = 'source';
      if (this.exportFormatSelect) this.exportFormatSelect.value = isWebm ? 'webm' : 'mp4';
      if (this.exportExtBadge) this.exportExtBadge.textContent = isWebm ? '.webm' : '.mp4';

    } else if (selectedMode === 'shorts-60fps') {
      if (this.advancedDropdownsGrid) this.advancedDropdownsGrid.style.display = 'none';
      if (this.lockedSettingsNote) this.lockedSettingsNote.style.display = 'flex';
      if (this.lockedNoteText) {
        this.lockedNoteText.textContent = 'Resolution locked to 1080×1920 (9:16) and format to MP4 (H.264).';
      }
      if (this.exportResolutionSelect) this.exportResolutionSelect.value = '1080p';
      if (this.exportFormatSelect) this.exportFormatSelect.value = 'mp4';
      if (this.exportExtBadge) this.exportExtBadge.textContent = '.mp4';

    } else {
      // Universal MP4: reveal resolution & format dropdowns
      if (this.advancedDropdownsGrid) this.advancedDropdownsGrid.style.display = 'grid';
      if (this.lockedSettingsNote) this.lockedSettingsNote.style.display = 'none';
      const curFormat = this.exportFormatSelect ? this.exportFormatSelect.value : 'mp4';
      if (this.exportExtBadge) this.exportExtBadge.textContent = `.${curFormat === 'webm' ? 'webm' : 'mp4'}`;
    }

    if (window.feather) feather.replace();
  }

  setSourceMeta(sourcePath, meta) {
    this.currentSourcePath = sourcePath;
    this.meta = meta;
    if (this.btnOpenExport) this.btnOpenExport.disabled = false;

    if (this.exportSourceSpecVal && meta) {
      const res = meta.width >= 3800 ? '4K' : (meta.width >= 1900 ? '1080p' : `${meta.width}×${meta.height}`);
      const fps = meta.fps ? `${Math.round(meta.fps)} FPS` : '60 FPS';
      const codec = meta.videoCodec ? meta.videoCodec.toUpperCase() : 'H264';
      this.exportSourceSpecVal.textContent = `${res} ${fps} (${codec})`;
    }

    const isWebm = (sourcePath && sourcePath.toLowerCase().endsWith('.webm')) ||
                   (meta && (meta.videoCodec === 'vp9' || meta.videoCodec === 'vp8'));

    if (this.exportFormatSelect) {
      this.exportFormatSelect.value = isWebm ? 'webm' : 'mp4';
    }
    this.updateEnginePreview();
  }

  syncAspectRatio(ratio) {
    if (this.exportAspectVal) {
      this.exportAspectVal.textContent = ratio === '9:16' ? '9:16 Vertical Reel' : '16:9 Landscape';
    }
    if (ratio === '9:16') {
      if (this.cardShorts60fps) this.cardShorts60fps.click();
    } else {
      if (this.cardGodSpeed) this.cardGodSpeed.click();
    }
    this.updateEnginePreview();
  }

  updateStats(segments, totalCut) {
    if (this.exportClipsVal) {
      this.exportClipsVal.textContent = `${segments.length} Clip${segments.length > 1 ? 's' : ''}`;
    }
    if (this.exportLengthVal) {
      const formatted = this.player.formatTimecode(totalCut).replace(/\.\d+$/, '');
      this.exportLengthVal.textContent = formatted.startsWith('00:') ? formatted.slice(3) : formatted;
    }
    if (this.exportEstSizeVal) {
      const isShorts = (this.player && this.player.aspectRatio === '9:16');
      const mbps = isShorts ? 6.5 : ((this.meta && this.meta.width > 2000) ? 16 : 8.5);
      const estMegabytes = Math.max(1, Math.round((totalCut * mbps) / 8));
      if (estMegabytes > 1024) {
        this.exportEstSizeVal.textContent = `Est. ~${(estMegabytes / 1024).toFixed(1)} GB`;
      } else {
        this.exportEstSizeVal.textContent = `Est. ~${estMegabytes} MB`;
      }
    }
  }

  showModal() {
    this.exportSetupSection.style.display = 'flex';
    this.exportProgressSection.style.display = 'none';
    this.exportSuccessBox.style.display = 'none';
    this.exportModal.style.display = 'flex';

    if (this.player.aspectRatio === '9:16') {
      if (this.cardShorts60fps) this.cardShorts60fps.click();
    } else {
      if (this.cardGodSpeed) this.cardGodSpeed.click();
    }

    if (this.meta && this.exportSourceSpecVal) {
      const res = this.meta.width >= 3800 ? '4K' : (this.meta.width >= 1900 ? '1080p' : `${this.meta.width}×${this.meta.height}`);
      const fps = this.meta.fps ? `${Math.round(this.meta.fps)} FPS` : '60 FPS';
      const codec = this.meta.videoCodec ? this.meta.videoCodec.toUpperCase() : 'H264';
      this.exportSourceSpecVal.textContent = `${res} ${fps} (${codec})`;
    }

    this.updateEnginePreview();
    if (window.feather) feather.replace();
  }

  hideModal() {
    if (this.currentJobId && this.exportProgressSection.style.display !== 'none' && this.exportSuccessBox.style.display !== 'flex') {
      if (confirm('An export is currently running. Do you want to cancel it?')) {
        fetch(`/api/export/${this.currentJobId}`, { method: 'DELETE' }).catch(() => {});
      }
    }
    if (this.activeSse) {
      this.activeSse.close();
      this.activeSse = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.currentJobId = null;
    this.exportModal.style.display = 'none';
  }

  async startExport() {
    const segments = this.timeline.getSegments();
    if (!segments || segments.length === 0) {
      alert('No segments to export.');
      return;
    }

    const modeInput = document.querySelector('input[name="exportMode"]:checked');
    const selectedMode = modeInput ? modeInput.value : 'godspeed';

    const format = this.exportFormatSelect ? this.exportFormatSelect.value : 'mp4';
    const resolution = this.exportResolutionSelect ? this.exportResolutionSelect.value : 'source';
    const customFileName = this.exportCustomFileName ? this.exportCustomFileName.value.trim() : '';

    const aspectRatio = (selectedMode === 'shorts-60fps') ? '9:16' : (this.player.aspectRatio || '16:9');
    const cropOffsetX = this.player.cropOffsetX !== undefined ? this.player.cropOffsetX : 0.5;
    const zoomScale = this.player.zoomScale || 1.0;

    // Determine Pan Start & End based on motion mode
    let panStart = cropOffsetX;
    let panEnd = cropOffsetX;
    if (this.player.motionPanMode === 'pan-lr') {
      panStart = 0.0;
      panEnd = 1.0;
    } else if (this.player.motionPanMode === 'pan-rl') {
      panStart = 1.0;
      panEnd = 0.0;
    }

    this.exportSetupSection.style.display = 'none';
    this.exportProgressSection.style.display = 'flex';
    this.exportSuccessBox.style.display = 'none';
    this.exportMeterBar.style.width = '0%';
    this.exportPercentageText.textContent = '0%';
    this.exportStageText.textContent = 'Launching export at maximum compute...';
    this.exportSpeedMetric.textContent = '--';
    this.exportTimeLeftMetric.textContent = '--';

    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourcePath: this.currentSourcePath || (segments[0] ? segments[0].sourcePath : null),
          segments,
          aspectRatio,
          cropOffsetX,
          panStart,
          panEnd,
          zoomScale,
          mode: selectedMode,
          outputFormat: format,
          resolution,
          customFileName
        })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Export failed');
      }

      const data = await res.json();
      this.currentJobId = data.jobId;
      this.listenProgress(data.jobId);

    } catch (err) {
      alert(`Export error: ${err.message}`);
      this.exportSetupSection.style.display = 'flex';
      this.exportProgressSection.style.display = 'none';
    }
  }

  listenProgress(jobId) {
    if (this.activeSse) {
      this.activeSse.close();
      this.activeSse = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    const handleUpdate = (data) => {
      if (!data) return;

      if (data.status === 'processing') {
        const pct = Math.min(99, data.progress || 0);
        this.exportMeterBar.style.width = `${pct}%`;
        this.exportPercentageText.textContent = `${pct}%`;
        this.exportStageText.textContent = data.stage || 'Exporting...';
        this.exportSpeedMetric.textContent = data.speed || '⚡ Fast';
        this.exportTimeLeftMetric.textContent = data.timeRemaining || '--';
      } else if (data.status === 'completed') {
        this.exportMeterBar.style.width = '100%';
        this.exportPercentageText.textContent = '100%';
        this.exportStageText.textContent = 'Done!';

        this.lastExportedFile = data.fullOutputPath;
        this.exportSuccessBox.style.display = 'flex';
        this.finishedFileName.textContent = data.fileName;
        this.btnDownloadFinished.href = data.downloadUrl;
        if (window.feather) feather.replace();

        if (this.activeSse) {
          this.activeSse.close();
          this.activeSse = null;
        }
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
      } else if (data.status === 'error') {
        alert(`Export failed: ${data.error}`);
        if (this.activeSse) {
          this.activeSse.close();
          this.activeSse = null;
        }
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
        this.hideModal();
      } else if (data.status === 'cancelled') {
        if (this.activeSse) {
          this.activeSse.close();
          this.activeSse = null;
        }
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
        this.currentJobId = null;
        this.exportSetupSection.style.display = 'flex';
        this.exportProgressSection.style.display = 'none';
      }
    };

    // 1. Primary real-time stream via SSE
    try {
      const sse = new EventSource(`/api/export-progress/${jobId}`);
      this.activeSse = sse;

      sse.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleUpdate(data);
        } catch (e) {}
      };

      sse.onerror = () => {
        // SSE network blip: do not close immediately; let fallback polling seamlessly continue
      };
    } catch (e) {}

    // 2. High-reliability fallback polling (guarantees completion update even if SSE drops)
    this.pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/export-status/${jobId}`);
        if (res.ok) {
          const data = await res.json();
          handleUpdate(data);
        }
      } catch (err) {}
    }, 800);
  }
}

window.ExportManager = ExportManager;
