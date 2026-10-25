/**
 * MonoCut - Video Player Controller & 9:16 Smartphone Viewport
 * Features:
 * - Full-Height 9:16 Smartphone Canvas for YouTube Shorts
 * - Real-time Object-Position Panning (Left, Center, Right, Slider & Direct Drag)
 * - YouTube Shorts Safe Zone UI Guide Toggle
 * - Seamless Loop Preview [O]
 * - Keyframe Zoom Punch-ins (1.0x, 1.25x, 1.5x)
 */

class VideoPlayer {
  constructor() {
    this.video = document.getElementById('mainVideo');
    this.playerContainer = document.getElementById('playerContainer');
    this.shortsControlBar = document.getElementById('shortsControlBar');
    this.cropPanSlider = document.getElementById('cropPanSlider');
    this.cropPanVal = document.getElementById('cropPanVal');
    this.btnToggleSafeZone = document.getElementById('btnToggleSafeZone');
    this.safeZoneOverlayYT = document.getElementById('safeZoneOverlayYT');
    this.dragCueBadge = document.getElementById('dragCueBadge');

    // Playback Transport UI
    this.timeCurrent = document.getElementById('timeCurrent');
    this.timeTotal = document.getElementById('timeTotal');
    this.btnPlayPause = document.getElementById('btnPlayPause');
    this.playIcon = document.getElementById('playIcon');
    this.btnToggleLoop = document.getElementById('btnToggleLoop');
    this.btnSaveFrame = document.getElementById('btnSaveFrame');
    this.volumeSlider = document.getElementById('volumeSlider');
    this.btnToggleMute = document.getElementById('btnToggleMute');
    this.volumeIcon = document.getElementById('volumeIcon');
    this.btnPlaybackSpeed = document.getElementById('btnPlaybackSpeed');

    // Custom Speed Popover Elements
    this.speedPopover = document.getElementById('speedPopover');
    this.speedCurrentDisplay = document.getElementById('speedCurrentDisplay');
    this.speedCustomInput = document.getElementById('speedCustomInput');
    this.btnApplyCustomSpeed = document.getElementById('btnApplyCustomSpeed');
    this.speedRangeSlider = document.getElementById('speedRangeSlider');

    // State (Defaults to 16:9 Landscape for high-performance widescreen editing)
    this.fps = 59.94;
    this.aspectRatio = '16:9';
    this.playbackRate = 1.0;
    this.cropOffsetX = 0.5; // 0.0 to 1.0 (0.5 = Center)
    this.motionPanMode = 'static'; // 'static' | 'pan-lr' | 'pan-rl'
    this.zoomScale = 1.0; // 1.0 | 1.25 | 1.5
    this.isLooping = false;
    this.isSafeZoneVisible = false;
    this.isDraggingCrop = false;
    this.videoLoaded = false;
    this.currentSourceUri = null;
    this.speeds = [0.5, 1.0, 1.5, 2.0];
    this.speedIdx = 1;

    this.isSeeking = false;
    this.isTransitioning = false;
    this.pendingSeekTime = null;
    this.pendingSeekIsFast = false;
    this.pendingScrubSeek = null;
    this.scrubSeekTimer = null;
    this.playbackRafId = null;
    this.playbackRvfcId = null;
    this.seekRafId = null;

    // Pre-buffered secondary video element for gapless multi-clip transitions
    this.prewarmVideo = document.createElement('video');
    this.prewarmVideo.muted = true;
    this.prewarmVideo.preload = 'auto';
    this.prewarmVideo.playsInline = true;
    this.prewarmVideo.style.display = 'none';
    this.prewarmTargetUri = null;
    this.prewarmTargetTime = null;
    document.body.appendChild(this.prewarmVideo);

    this.initEvents();
    this.setPlayIcon(false);
    this.updateVolumeIcon();
  }

  initEvents() {
    // Sub-16ms Presentation-Locked Playback Loop via requestVideoFrameCallback (fallback to RAF)
    const startPlaybackLoop = () => {
      stopPlaybackLoop();
      const tick = (now, metadata) => {
        if (!this.video.paused && !this.video.ended) {
          this.updateTimecode();
          this.handleMotionPanUpdate();
          this.handlePlaybackSequence();
          if ('requestVideoFrameCallback' in this.video) {
            this.playbackRvfcId = this.video.requestVideoFrameCallback(tick);
          } else {
            this.playbackRafId = requestAnimationFrame(tick);
          }
        } else {
          this.playbackRvfcId = null;
          this.playbackRafId = null;
        }
      };

      if ('requestVideoFrameCallback' in this.video) {
        this.playbackRvfcId = this.video.requestVideoFrameCallback(tick);
      } else {
        this.playbackRafId = requestAnimationFrame(tick);
      }
    };

    const stopPlaybackLoop = () => {
      if (this.playbackRvfcId !== null && 'cancelVideoFrameCallback' in this.video) {
        try { this.video.cancelVideoFrameCallback(this.playbackRvfcId); } catch (e) {}
        this.playbackRvfcId = null;
      }
      if (this.playbackRafId) {
        cancelAnimationFrame(this.playbackRafId);
        this.playbackRafId = null;
      }
      this.updateTimecode();
    };

    // Video timeupdate fallback (only active when RVFC/RAF loop is suspended)
    this.video.addEventListener('timeupdate', () => {
      if (!this.playbackRafId && !this.playbackRvfcId) {
        this.updateTimecode();
        this.handleMotionPanUpdate();
        this.handlePlaybackSequence();
      }
    });

    this.video.addEventListener('loadedmetadata', () => {
      this.videoLoaded = true;
      this.updateTimecode();
      this.setAspectRatio(this.aspectRatio);
      this.setCropOffset(this.cropOffsetX);
    });

    this.video.addEventListener('play', () => {
      this.setPlayIcon(true);
      startPlaybackLoop();
      if (this.dragCueBadge) {
        setTimeout(() => { this.dragCueBadge.style.opacity = '0'; }, 2000);
      }
    });

    this.video.addEventListener('pause', () => {
      this.setPlayIcon(false);
      stopPlaybackLoop();
    });
    
    this.video.addEventListener('ended', () => {
      stopPlaybackLoop();
      if (this.isLooping) {
        this.restartLoop();
      } else {
        this.setPlayIcon(false);
      }
    });

    this.video.addEventListener('seeking', () => {
      this.isSeeking = true;
    });

    this.video.addEventListener('seeked', () => {
      this.onSeekComplete();
    });

    this.video.addEventListener('error', (err) => {
      console.warn('Video playback notice:', err);
      this.setPlayIcon(false);
      stopPlaybackLoop();
    });

    // Playback buttons with focus blur to prevent keyboard spacebar conflict
    this.btnPlayPause.addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.togglePlay();
    });
    document.getElementById('btnStepPrev').addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.stepFrame(-1);
    });
    document.getElementById('btnStepNext').addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.stepFrame(1);
    });
    document.getElementById('btnRewind5s').addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.seekDelta(-5);
    });
    document.getElementById('btnForward5s').addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.seekDelta(5);
    });

    // Seamless Loop toggle
    if (this.btnToggleLoop) {
      this.btnToggleLoop.addEventListener('click', (e) => {
        e.currentTarget.blur();
        this.toggleLoop();
      });
    }

    // Native 4K Save Paused Frame Snapshot [P]
    if (this.btnSaveFrame) {
      this.btnSaveFrame.addEventListener('click', (e) => {
        e.currentTarget.blur();
        this.captureCurrentFrame();
      });
    }

    // Volume
    this.volumeSlider.addEventListener('input', (e) => {
      this.video.volume = parseFloat(e.target.value);
      this.video.muted = false;
      this.updateVolumeIcon();
    });

    this.btnToggleMute.addEventListener('click', () => {
      this.video.muted = !this.video.muted;
      this.updateVolumeIcon();
    });

    // Playback Speed & Custom Speed Popover
    if (this.btnPlaybackSpeed) {
      this.btnPlaybackSpeed.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleSpeedPopover();
      });
    }

    if (this.btnApplyCustomSpeed) {
      this.btnApplyCustomSpeed.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = parseFloat(this.speedCustomInput.value);
        if (!isNaN(val) && val > 0) {
          this.setPlaybackSpeed(val);
          this.toggleSpeedPopover(false);
        }
      });
    }

    if (this.speedCustomInput) {
      this.speedCustomInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const val = parseFloat(this.speedCustomInput.value);
          if (!isNaN(val) && val > 0) {
            this.setPlaybackSpeed(val);
            this.toggleSpeedPopover(false);
          }
        }
      });
      this.speedCustomInput.addEventListener('input', () => {
        const val = parseFloat(this.speedCustomInput.value);
        if (!isNaN(val) && val > 0) {
          this.setPlaybackSpeed(val, false);
        }
      });
    }

    if (this.speedRangeSlider) {
      this.speedRangeSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        this.setPlaybackSpeed(val, false);
        if (this.speedCustomInput) {
          this.speedCustomInput.value = val.toFixed(2);
        }
      });
    }

    document.querySelectorAll('.speed-preset-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const spd = parseFloat(btn.dataset.speed);
        if (!isNaN(spd)) {
          this.setPlaybackSpeed(spd);
        }
      });
    });

    window.addEventListener('click', (e) => {
      if (this.speedPopover && this.speedPopover.style.display !== 'none') {
        if (!this.speedPopover.contains(e.target) && e.target !== this.btnPlaybackSpeed) {
          this.toggleSpeedPopover(false);
        }
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.speedPopover && this.speedPopover.style.display !== 'none') {
        this.toggleSpeedPopover(false);
      }
    });

    // 9:16 Framing Preset Buttons
    document.querySelectorAll('.preset-pill[data-preset]').forEach(pill => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('.preset-pill[data-preset]').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        this.setMotionPanMode('static');
        this.setCropOffset(parseFloat(pill.dataset.preset));
      });
    });

    // Pan Slider
    this.cropPanSlider.addEventListener('input', (e) => {
      this.setMotionPanMode('static');
      this.setCropOffset(parseInt(e.target.value) / 100);
      document.querySelectorAll('.preset-pill[data-preset]').forEach(p => p.classList.remove('active'));
    });

    // Motion Tracking Auto-Pan Buttons
    document.querySelectorAll('.motion-btn[data-motion]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.setMotionPanMode(btn.dataset.motion);
      });
    });

    // Zoom Punch-in Buttons (1.0x, 1.25x, 1.5x)
    document.querySelectorAll('.punch-btn[data-zoom]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.setZoomScale(parseFloat(btn.dataset.zoom));
      });
    });

    // YouTube Shorts Safe Zone Guide Toggle
    if (this.btnToggleSafeZone) {
      this.btnToggleSafeZone.addEventListener('click', () => this.toggleSafeZone());
    }

    // Direct Drag-to-Pan on Video Viewport
    this.setupDirectViewportPan();
  }

  // =========================================================
  // VIEWPORT PANNING & FRAMING
  // =========================================================

  setupDirectViewportPan() {
    let startX = 0;
    let startY = 0;
    let startOffset = 0.5;
    let hasMoved = false;

    const onMouseDown = (e) => {
      if (!this.videoLoaded) return;
      if (e.target.closest('.sz-icon-circle') || e.target.closest('.preset-pill') || e.target.closest('button')) return;

      startX = e.clientX;
      startY = e.clientY;
      hasMoved = false;
      startOffset = this.cropOffsetX;

      if (this.aspectRatio === '9:16') {
        this.isDraggingCrop = true;
        this.setMotionPanMode('static');
      }

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    };

    const onMouseMove = (e) => {
      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;
      if (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4) {
        hasMoved = true;
      }

      if (!this.isDraggingCrop) return;
      // Dragging left moves frame right (revealing right side of 16:9)
      const containerWidth = this.playerContainer.clientWidth || 300;
      const travelRatio = deltaX / (containerWidth * 1.6);
      const newOffset = Math.max(0, Math.min(1, startOffset - travelRatio));
      
      this.setCropOffset(newOffset);
      document.querySelectorAll('.preset-pill[data-preset]').forEach(p => p.classList.remove('active'));
    };

    const onMouseUp = (e) => {
      this.isDraggingCrop = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);

      // If user clicked without dragging, toggle Play/Pause!
      if (!hasMoved) {
        this.togglePlay();
      }
    };

    this.playerContainer.addEventListener('mousedown', onMouseDown);
  }

  setCropOffset(offset, updateSlider = true, saveToClip = true) {
    this.cropOffsetX = Math.max(0, Math.min(1, offset));

    if (saveToClip && window.timeline && window.timeline.activeClipId) {
      const seg = window.timeline.segments.find(s => s.id === window.timeline.activeClipId);
      if (seg) {
        seg.cropOffsetX = this.cropOffsetX;
      }
    }

    if (this.aspectRatio === '9:16') {
      const pct = Math.round(this.cropOffsetX * 100);
      this.video.style.objectPosition = `${pct}% center`;

      if (updateSlider && this.cropPanSlider && this.cropPanVal) {
        this.cropPanSlider.value = pct;
        this.cropPanVal.textContent = `${pct}%`;
      }
    }
  }

  setAspectRatio(ratio) {
    this.aspectRatio = ratio;
    this.playerContainer.dataset.aspect = ratio;

    const btnOpenExport = document.getElementById('btnOpenExport');

    if (ratio === '9:16') {
      if (this.shortsControlBar) this.shortsControlBar.style.display = 'flex';
      this.video.style.objectFit = 'cover';
      this.setCropOffset(this.cropOffsetX);
      if (this.isSafeZoneVisible && this.safeZoneOverlayYT) {
        this.safeZoneOverlayYT.style.display = 'flex';
      }
      if (btnOpenExport) {
        btnOpenExport.innerHTML = `<i data-feather="download"></i><span>Export Shorts</span>`;
      }
    } else {
      if (this.shortsControlBar) this.shortsControlBar.style.display = 'none';
      this.video.style.objectFit = 'contain';
      this.video.style.objectPosition = 'center center';
      if (this.safeZoneOverlayYT) this.safeZoneOverlayYT.style.display = 'none';
      if (btnOpenExport) {
        btnOpenExport.innerHTML = `<i data-feather="download"></i><span>Export 16:9</span>`;
      }
    }

    if (window.exportManager) {
      window.exportManager.syncAspectRatio(ratio);
    }
    if (window.timeline) {
      window.timeline.updateStats();
    }
    feather.replace();
  }

  toggleSafeZone() {
    this.isSafeZoneVisible = !this.isSafeZoneVisible;
    if (this.btnToggleSafeZone) {
      this.btnToggleSafeZone.classList.toggle('active', this.isSafeZoneVisible);
      const iconSvg = this.isSafeZoneVisible
        ? `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`
        : `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
      this.btnToggleSafeZone.innerHTML = `${iconSvg}<span>YouTube Shorts Safe Zone</span>`;
    }

    if (this.safeZoneOverlayYT) {
      this.safeZoneOverlayYT.style.display = (this.isSafeZoneVisible && this.aspectRatio === '9:16') ? 'flex' : 'none';
    }
  }

  // =========================================================
  // KEYFRAME PUNCH-IN & DYNAMIC ZOOM
  // =========================================================

  setZoomScale(scale, saveToClip = true) {
    this.zoomScale = scale;

    if (saveToClip && window.timeline && window.timeline.activeClipId) {
      const seg = window.timeline.segments.find(s => s.id === window.timeline.activeClipId);
      if (seg) {
        seg.zoomScale = scale;
      }
    }

    document.querySelectorAll('.punch-btn[data-zoom]').forEach(btn => {
      btn.classList.toggle('active', parseFloat(btn.dataset.zoom) === scale);
    });

    if (this.video) {
      if (scale > 1.02) {
        this.video.style.transform = `scale(${scale})`;
        this.video.style.transformOrigin = 'center center';
      } else {
        this.video.style.transform = 'none';
      }
    }
  }

  syncActiveClipProperties() {
    if (!window.timeline || !window.timeline.segments || window.timeline.segments.length === 0) return;
    const seg = window.timeline.segments.find(s => s.id === window.timeline.activeClipId);
    if (seg) {
      const zoom = seg.zoomScale || 1.0;
      this.setZoomScale(zoom, false);
      if (seg.cropOffsetX !== undefined) {
        this.setCropOffset(seg.cropOffsetX, true, false);
      }
      this.syncClipPlaybackRate(seg);
    }
  }

  syncClipPlaybackRate(seg) {
    if (!this.video) return;
    const activeSeg = seg || (window.timeline && window.timeline.segments && window.timeline.segments.find(s => s.id === window.timeline.activeClipId));
    const clipSpeed = (activeSeg && activeSeg.speed) ? activeSeg.speed : 1.0;
    const effectiveRate = Math.max(0.05, Math.min(16.0, (this.playbackRate || 1.0) * clipSpeed));
    try {
      this.video.preservesPitch = true;
      if (Math.abs(this.video.playbackRate - effectiveRate) > 0.01) {
        this.video.playbackRate = effectiveRate;
      }
    } catch (e) {}
  }

  // =========================================================
  // SMART MOTION TRACKING AUTO-PAN
  // =========================================================

  setMotionPanMode(mode) {
    this.motionPanMode = mode;

    document.querySelectorAll('.motion-btn[data-motion]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.motion === mode);
    });

    if (mode === 'pan-lr') {
      this.setCropOffset(0.0, true);
    } else if (mode === 'pan-rl') {
      this.setCropOffset(1.0, true);
    }
  }

  handleMotionPanUpdate() {
    if (this.aspectRatio !== '9:16' || this.motionPanMode === 'static' || !this.videoLoaded) return;

    let startTime = 0;
    let endTime = this.video.duration || 10;

    if (window.timeline && window.timeline.segments && window.timeline.segments.length > 0) {
      const activeSeg = window.timeline.segments.find(s => s.id === window.timeline.activeClipId);
      if (activeSeg) {
        startTime = activeSeg.start;
        endTime = activeSeg.end;
      }
    }

    const segDuration = Math.max(0.1, endTime - startTime);
    const progress = Math.max(0, Math.min(1, (this.video.currentTime - startTime) / segDuration));

    if (this.motionPanMode === 'pan-lr') {
      this.setCropOffset(progress, false);
    } else if (this.motionPanMode === 'pan-rl') {
      this.setCropOffset(1.0 - progress, false);
    }
  }

  // =========================================================
  // SEAMLESS LOOP PREVIEW
  // =========================================================

  toggleLoop() {
    this.isLooping = !this.isLooping;
    if (this.btnToggleLoop) {
      this.btnToggleLoop.classList.toggle('active', this.isLooping);
    }
  }

  /**
   * Native Full-Resolution Frame Snapshot Capture Engine [P]
   */
  captureCurrentFrame() {
    if (!this.videoLoaded || !this.video) {
      if (typeof window.showStudioToast === 'function') {
        window.showStudioToast("⚠️ No video loaded to capture frame");
      }
      return;
    }

    // Auto-pause if actively playing
    if (!this.video.paused) {
      this.pause();
    }

    const srcW = this.video.videoWidth || 1920;
    const srcH = this.video.videoHeight || 1080;

    // Create offscreen canvas for zero UI distortion capture
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    let outW = srcW;
    let outH = srcH;

    if (this.aspectRatio === '9:16') {
      // 9:16 vertical crop geometry in native pixel coordinates
      const cropW = Math.round(srcH * (9 / 16));
      const cropH = srcH;
      const maxOffset = Math.max(0, srcW - cropW);
      const cropOffset = (this.cropOffsetX !== undefined) ? this.cropOffsetX : 0.5;
      let sx = Math.round(maxOffset * cropOffset);
      let sy = 0;
      let sw = cropW;
      let sh = cropH;

      // Handle Keyframe Zoom Punch if active
      if (this.zoomScale && this.zoomScale > 1.0) {
        const zoomedW = Math.round(cropW / this.zoomScale);
        const zoomedH = Math.round(cropH / this.zoomScale);
        sx += Math.round((cropW - zoomedW) / 2);
        sy += Math.round((cropH - zoomedH) / 2);
        sw = zoomedW;
        sh = zoomedH;
      }

      // Bound coordinates within source dimensions
      sx = Math.max(0, Math.min(srcW - sw, sx));
      sy = Math.max(0, Math.min(srcH - sh, sy));

      // 9:16 resolution (1080x1920 or native 4K 2160x3840)
      outW = (cropW >= 1080) ? 1080 : cropW;
      outH = (cropH >= 1920) ? 1920 : cropH;
      if (cropW >= 2160 || cropH >= 3840) {
        outW = 2160;
        outH = 3840;
      }
      canvas.width = outW;
      canvas.height = outH;

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.video, sx, sy, sw, sh, 0, 0, outW, outH);

    } else {
      // 16:9 Landscape geometry
      let sx = 0;
      let sy = 0;
      let sw = srcW;
      let sh = srcH;

      if (this.zoomScale && this.zoomScale > 1.0) {
        sw = Math.round(srcW / this.zoomScale);
        sh = Math.round(srcH / this.zoomScale);
        sx = Math.round((srcW - sw) / 2);
        sy = Math.round((srcH - sh) / 2);
      }

      outW = srcW;
      outH = srcH;
      canvas.width = outW;
      canvas.height = outH;

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.video, sx, sy, sw, sh, 0, 0, outW, outH);
    }

    // Trigger visual camera shutter flash (150ms) on player container
    if (this.playerContainer) {
      this.playerContainer.classList.add('shutter-flash');
      setTimeout(() => {
        this.playerContainer.classList.remove('shutter-flash');
      }, 150);
    }

    // Button flash cue & blur to prevent spacebar lock
    const btnSaveFrame = document.getElementById('btnSaveFrame');
    if (btnSaveFrame) {
      btnSaveFrame.classList.add('flash-success');
      setTimeout(() => {
        btnSaveFrame.classList.remove('flash-success');
      }, 350);
      btnSaveFrame.blur();
    }

    // Format deterministic filename: ${sanitizedVideoBaseName}_${formattedTimecode_HH-MM-SS.mmm}.png
    const curTime = this.video.currentTime || 0;
    const hours = Math.floor(curTime / 3600);
    const mins = Math.floor((curTime % 3600) / 60);
    const secs = Math.floor(curTime % 60);
    const ms = Math.floor((curTime % 1) * 1000);
    const timecodeStr = `${String(hours).padStart(2, '0')}-${String(mins).padStart(2, '0')}-${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;

    let baseName = 'frame';
    if (window.timeline && window.timeline.segments && window.timeline.activeClipId) {
      const activeSeg = window.timeline.segments.find(s => s.id === window.timeline.activeClipId);
      if (activeSeg && activeSeg.fileName) {
        baseName = activeSeg.fileName.replace(/\.[^/.]+$/, '');
      }
    }
    if (baseName === 'frame' && this.currentSourceUri) {
      const parts = this.currentSourceUri.split('/');
      baseName = parts[parts.length - 1].split('?')[0].replace(/\.[^/.]+$/, '');
    }
    const cleanBaseName = baseName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${cleanBaseName}_${timecodeStr}.png`;

    // Lossless PNG conversion and browser file download
    canvas.toBlob(blob => {
      if (!blob) return;
      const blobUrl = URL.createObjectURL(blob);
      const downloadLink = document.createElement('a');
      downloadLink.href = blobUrl;
      downloadLink.download = fileName;
      document.body.appendChild(downloadLink);
      downloadLink.click();
      document.body.removeChild(downloadLink);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 2500);

      // Non-intrusive studio toast notification
      if (typeof window.showStudioToast === 'function') {
        window.showStudioToast(`📸 Frame saved (${outW}×${outH} PNG)`);
      }
    }, 'image/png');
  }

  handlePlaybackSequence() {
    if (!this.videoLoaded || this.video.paused || this.video.seeking || this.isTransitioning) return;

    const timeline = window.timeline;
    if (!timeline || !timeline.segments || timeline.segments.length === 0) return;

    const segs = timeline.segments;
    const curTime = this.video.currentTime;
    const curUri = this.currentSourceUri;

    // 1. Identify active clip matching current video currentTime and activeClipId
    let curIdx = -1;
    if (timeline.activeClipId) {
      const aIdx = segs.findIndex(s => s.id === timeline.activeClipId);
      if (aIdx !== -1) {
        const s = segs[aIdx];
        const uriMatches = !curUri || !s.sourceUri || s.sourceUri === curUri;
        if (uriMatches && curTime >= (s.start - 0.08) && curTime <= (s.end + 0.08)) {
          curIdx = aIdx;
        }
      }
    }
    if (curIdx === -1) {
      curIdx = segs.findIndex(s => {
        const uriMatches = !curUri || !s.sourceUri || s.sourceUri === curUri;
        return uriMatches && curTime >= (s.start - 0.04) && curTime < s.end;
      });
    }

    if (curIdx !== -1) {
      const curSeg = segs[curIdx];
      const clipSpeed = curSeg.speed || 1.0;
      const effectiveRate = Math.max(0.05, Math.min(16.0, (this.playbackRate || 1.0) * clipSpeed));

      try {
        this.video.preservesPitch = true;
        if (Math.abs(this.video.playbackRate - effectiveRate) > 0.01) {
          this.video.playbackRate = effectiveRate;
        }
      } catch (e) {}

      const frameDuration = 1 / (this.fps || 60);
      const lookahead = Math.max(0.016, frameDuration * effectiveRate * 1.25);

      // Multi-clip pre-warming: pre-buffer next clip within 1.5 seconds of clip boundary
      const timeRemainingInClip = (curSeg.end - curTime) / clipSpeed;
      if (timeRemainingInClip <= 1.5 && timeRemainingInClip > 0) {
        const upcomingSeg = (curIdx < segs.length - 1) ? segs[curIdx + 1] : (this.isLooping ? segs[0] : null);
        if (upcomingSeg) {
          this.prewarmClip(upcomingSeg);
        }
      }

      if (curTime >= (curSeg.end - lookahead)) {
        // Next clip in sequence available?
        if (curIdx < segs.length - 1) {
          const nextSeg = segs[curIdx + 1];

          // CRITICAL OPTIMIZATION: Contiguous split clips from the SAME video with SAME speed!
          // If the next clip starts where the current clip ends, playback is already smooth!
          // NEVER seek! Simply advance activeClipId with zero decoder stall or frame breaking!
          const sameSource = (!nextSeg.sourceUri || !curSeg.sourceUri || nextSeg.sourceUri === curSeg.sourceUri);
          const isContiguous = sameSource && Math.abs(nextSeg.start - curSeg.end) <= 0.08;

          if (isContiguous) {
            timeline.activeClipId = nextSeg.id;
            timeline.highlightActive();
            return;
          }

          // Non-contiguous cut or different video file: execute clean jump
          this.isTransitioning = true;
          timeline.activeClipId = nextSeg.id;
          timeline.highlightActive();

          if (!sameSource) {
            this.switchSource(nextSeg.sourceUri, nextSeg.start, true);
          } else {
            this.seek(nextSeg.start);
          }

          const onTransitionEnd = () => {
            this.isTransitioning = false;
            this.video.removeEventListener('seeked', onTransitionEnd);
          };
          this.video.addEventListener('seeked', onTransitionEnd, { once: true });
          setTimeout(onTransitionEnd, 350);

        } else {
          // Reached the end of the last clip in sequence
          if (this.isLooping) {
            const firstSeg = segs[0];
            this.isTransitioning = true;
            timeline.activeClipId = firstSeg.id;
            timeline.highlightActive();

            const sameSource = (!firstSeg.sourceUri || !curSeg.sourceUri || firstSeg.sourceUri === curSeg.sourceUri);
            if (!sameSource) {
              this.switchSource(firstSeg.sourceUri, firstSeg.start, true);
            } else {
              this.seek(firstSeg.start);
            }

            const onTransitionEnd = () => {
              this.isTransitioning = false;
              this.video.removeEventListener('seeked', onTransitionEnd);
            };
            this.video.addEventListener('seeked', onTransitionEnd, { once: true });
            setTimeout(onTransitionEnd, 350);
          } else {
            this.pause();
            this.seek(curSeg.end);
          }
        }
      }
    } else {
      // Playhead fell into a gap: safely advance to next sequential clip
      let nextClip = null;
      if (timeline.activeClipId) {
        const aIdx = segs.findIndex(s => s.id === timeline.activeClipId);
        if (aIdx !== -1 && aIdx < segs.length - 1) {
          nextClip = segs[aIdx + 1];
        }
      }
      if (!nextClip && segs.length > 0) {
        nextClip = segs[0];
      }

      if (nextClip && !this.isTransitioning) {
        this.isTransitioning = true;
        timeline.activeClipId = nextClip.id;
        timeline.highlightActive();

        const sameSource = (!nextClip.sourceUri || !this.currentSourceUri || nextClip.sourceUri === this.currentSourceUri);
        if (!sameSource) {
          this.switchSource(nextClip.sourceUri, nextClip.start, true);
        } else {
          this.seek(nextClip.start);
        }

        const onTransitionEnd = () => {
          this.isTransitioning = false;
          this.video.removeEventListener('seeked', onTransitionEnd);
        };
        this.video.addEventListener('seeked', onTransitionEnd, { once: true });
        setTimeout(onTransitionEnd, 350);
      }
    }
  }

  restartLoop() {
    if (window.timeline && window.timeline.segments && window.timeline.segments.length > 0) {
      const firstSeg = window.timeline.segments[0];
      window.timeline.activeClipId = firstSeg.id;
      window.timeline.highlightActive();
      this.seek(firstSeg.start);
      this.video.play().catch(() => {});
    } else {
      this.seek(0);
      this.video.play().catch(() => {});
    }
  }

  prewarmClip(seg) {
    if (!seg) return;
    const src = seg.sourceUri || this.currentSourceUri;
    if (!src) return;
    if (this.prewarmTargetUri === src && Math.abs((this.prewarmTargetTime || 0) - seg.start) < 0.1) {
      return; // Already prewarmed
    }
    this.prewarmTargetUri = src;
    this.prewarmTargetTime = seg.start;
    if (this.prewarmVideo.src !== src) {
      this.prewarmVideo.src = src;
      this.prewarmVideo.load();
    }
    const seekWhenReady = () => {
      try {
        this.prewarmVideo.currentTime = seg.start;
      } catch (e) {}
    };
    if (this.prewarmVideo.readyState >= 1) {
      seekWhenReady();
    } else {
      this.prewarmVideo.addEventListener('loadedmetadata', seekWhenReady, { once: true });
    }
  }

  // =========================================================
  // BASIC PLAYBACK CONTROLS
  // =========================================================

  loadSource(src, meta) {
    this.videoLoaded = true;
    this.currentSourceUri = src;
    this.video.src = src;
    this.video.load();
    if (meta) {
      if (meta.fps) this.fps = meta.fps;
      if (meta.duration) {
        this.timeTotal.textContent = this.formatTimecode(meta.duration);
      }
    }
    this.setAspectRatio(this.aspectRatio);
    this.updateVolumeIcon();
    this.setPlayIcon(false);
  }

  switchSource(src, targetTime = 0, autoPlay = false) {
    if (!src) return;
    if (this.currentSourceUri === src) {
      this.seek(targetTime);
      if (autoPlay && this.video.paused) {
        this.play();
      }
      return;
    }

    this.currentSourceUri = src;
    this.videoLoaded = true;
    this.isTransitioning = true;
    const wasPlaying = autoPlay || !this.video.paused;

    const onLoaded = () => {
      this.seek(targetTime);
      if (wasPlaying) {
        this.video.play().catch(() => {});
      }
      setTimeout(() => {
        this.isTransitioning = false;
      }, 80);
    };

    this.video.addEventListener('loadedmetadata', onLoaded, { once: true });
    this.video.src = src;
    this.video.load();
  }

  play() {
    if (!this.videoLoaded) return;
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }

    const timeline = window.timeline;
    if (timeline && timeline.totalDuration > 0 && timeline.segments && timeline.segments.length > 0) {
      const curSeq = timeline.getCurrentSequenceTime();
      // If at or past the end of the entire sequence, rewind to start of sequence
      if (curSeq >= (timeline.totalDuration - 0.05)) {
        timeline.seekToSequenceTime(0, false);
      }
    } else if (this.video.duration && this.video.currentTime >= this.video.duration - 0.08) {
      this.seek(0);
    }

    const p = this.video.play();
    if (p !== undefined) {
      p.catch(e => {
        if (e.name !== 'AbortError') {
          console.warn('Playback play() notice:', e);
        }
      });
    }
  }

  pause() {
    if (!this.videoLoaded) return;
    this.video.pause();
    this.setPlayIcon(false);
  }

  togglePlay() {
    if (!this.videoLoaded) return;
    if (this.video.paused) {
      this.play();
    } else {
      this.pause();
    }
  }

  stepFrame(count) {
    if (!this.videoLoaded) return;
    if (window.timeline && window.timeline.selectedEditPoint) {
      window.timeline.nudgeSelectedEditPoint(count);
      return;
    }
    this.pause();
    const frameTime = 1 / (this.fps || 60);
    if (window.timeline && window.timeline.totalDuration > 0 && window.timeline.segments.length > 0) {
      const curSeq = window.timeline.getCurrentSequenceTime();
      window.timeline.seekToSequenceTime(curSeq + (count * frameTime));
    } else {
      this.seek(this.video.currentTime + (count * frameTime));
    }
  }

  seekDelta(seconds) {
    if (!this.videoLoaded) return;
    if (window.timeline && window.timeline.totalDuration > 0 && window.timeline.segments.length > 0) {
      const curSeq = window.timeline.getCurrentSequenceTime();
      window.timeline.seekToSequenceTime(curSeq + seconds);
    } else {
      this.seek(this.video.currentTime + seconds);
    }
  }

  seek(time, isFast = false) {
    if (!this.videoLoaded) return;
    const dur = this.video.duration || (window.timeline ? window.timeline.totalDuration : 0);
    const target = Math.max(0, Math.min(dur, time));

    // Seek Lock Guard: If browser or player is already seeking, coalesce into single pending target
    if (this.video.seeking || this.isSeeking) {
      this.pendingSeekTime = target;
      this.pendingSeekIsFast = isFast;
      return;
    }

    this.pendingSeekTime = null;
    if (this.scrubSeekTimer) {
      clearTimeout(this.scrubSeekTimer);
      this.scrubSeekTimer = null;
    }
    this.performSeek(target, isFast);
  }

  performSeek(target, isFast = false) {
    if (!this.videoLoaded) return;
    this.isSeeking = true;
    try {
      if (isFast && typeof this.video.fastSeek === 'function') {
        this.video.fastSeek(target);
      } else {
        this.video.currentTime = target;
      }
    } catch (e) {}
    this.updateTimecode();

    // Hardware presentation sync
    if ('requestVideoFrameCallback' in this.video) {
      this.video.requestVideoFrameCallback(() => {
        this.onSeekComplete();
      });
    }

    // Fail-safe watchdog (250ms) to ensure scrubbing never deadlocks if browser drops an event
    if (this.scrubSeekTimer) clearTimeout(this.scrubSeekTimer);
    this.scrubSeekTimer = setTimeout(() => {
      this.onSeekComplete();
    }, 250);
  }

  onSeekComplete() {
    if (this.scrubSeekTimer) {
      clearTimeout(this.scrubSeekTimer);
      this.scrubSeekTimer = null;
    }
    if (!this.isSeeking && this.pendingSeekTime === null) {
      return;
    }
    this.isSeeking = false;
    this.isTransitioning = false;
    this.updateTimecode();

    // Immediately dispatch newest queued scrub target the instant seek finishes
    if (this.pendingSeekTime !== null) {
      const nextTarget = this.pendingSeekTime;
      const wasFast = Boolean(this.pendingSeekIsFast);
      this.pendingSeekTime = null;
      this.pendingSeekIsFast = false;
      this.performSeek(nextTarget, wasFast);
    }
  }

  setPlayIcon(isPlaying) {
    if (!this.btnPlayPause) return;
    this.btnPlayPause.title = isPlaying ? "Pause (Space)" : "Play (Space)";
    this.btnPlayPause.classList.toggle('playing', isPlaying);

    if (isPlaying) {
      // Pause symbol (two crisp solid vertical bars)
      this.btnPlayPause.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <rect x="6" y="4" width="4" height="16" rx="1"></rect>
          <rect x="14" y="4" width="4" height="16" rx="1"></rect>
        </svg>
      `;
    } else {
      // Play symbol (crisp solid equilateral triangle, optically centered)
      this.btnPlayPause.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style="transform: translateX(1px);">
          <polygon points="6 4 20 12 6 20"></polygon>
        </svg>
      `;
    }
  }

  updateVolumeIcon() {
    if (!this.btnToggleMute) return;
    const isMuted = this.video.muted || this.video.volume === 0;
    const vol = this.video.volume;

    let iconSvg = '';
    if (isMuted) {
      this.btnToggleMute.title = "Unmute (M)";
      iconSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`;
    } else if (vol < 0.5) {
      this.btnToggleMute.title = "Mute (M)";
      iconSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;
    } else {
      this.btnToggleMute.title = "Mute (M)";
      iconSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;
    }
    this.btnToggleMute.innerHTML = iconSvg;
  }

  updateTimecode() {
    const cur = this.video.currentTime || 0;
    if (window.timeline && window.timeline.totalDuration > 0) {
      window.timeline.onPlayerTimeUpdate(cur);
    } else {
      const dur = this.video.duration || 0;
      this.timeCurrent.textContent = this.formatTimecode(cur);
      this.timeTotal.textContent = this.formatTimecode(dur);
    }
  }

  toggleSpeedPopover(force) {
    if (!this.speedPopover) return;
    const shouldOpen = force !== undefined ? force : (this.speedPopover.style.display === 'none');
    this.speedPopover.style.display = shouldOpen ? 'flex' : 'none';
    if (this.btnPlaybackSpeed) {
      this.btnPlaybackSpeed.classList.toggle('menu-open', shouldOpen);
    }
    if (shouldOpen && this.speedCustomInput) {
      setTimeout(() => this.speedCustomInput.select(), 50);
    }
  }

  setPlaybackSpeed(speed, updateInputs = true) {
    const rate = Math.max(0.05, Math.min(16.0, parseFloat(speed) || 1.0));
    const rounded = Math.round(rate * 100) / 100;
    this.playbackRate = rounded;

    try {
      this.video.playbackRate = rounded;
    } catch (e) {}

    // Update pill text & modified state
    if (this.btnPlaybackSpeed) {
      this.btnPlaybackSpeed.textContent = `${rounded}×`;
      this.btnPlaybackSpeed.classList.toggle('modified', Math.abs(rounded - 1.0) > 0.01);
    }

    if (this.speedCurrentDisplay) {
      this.speedCurrentDisplay.textContent = `${rounded}×`;
    }

    if (updateInputs) {
      if (this.speedCustomInput) {
        this.speedCustomInput.value = rounded;
      }
      if (this.speedRangeSlider) {
        this.speedRangeSlider.value = Math.min(5.0, Math.max(0.1, rounded));
      }
    }

    // Update preset chips
    document.querySelectorAll('.speed-preset-btn').forEach(btn => {
      const btnSpeed = parseFloat(btn.dataset.speed);
      btn.classList.toggle('active', Math.abs(btnSpeed - rounded) < 0.01);
    });
  }

  formatTimecode(seconds) {
    if (isNaN(seconds) || seconds < 0) seconds = 0;
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.min(999, Math.max(0, Math.floor((seconds % 1) * 1000)));
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}.${pad(ms, 3)}`;
  }
}

window.VideoPlayer = VideoPlayer;
