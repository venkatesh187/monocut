/**
 * MonoCut - Magnetic / Ripple Sequence Timeline Engine
 * Features:
 * - 100% Fit-to-Screen Magnetic Sequence Timeline
 * - Real-time Smooth Directional Video Scrubbing on Drag
 * - Interactive Hover Ghost Line & Keyframe Preview Tooltip
 * - Real Video Filmstrip Backgrounds on each clip (Edge-to-Edge)
 * - Ripple trim handles on both sides of each clip
 * - Contiguous multi-clip playback (skips deleted footage seamlessly)
 * - YouTube Shorts (≤60s) duration cap indicator
 * - Full Undo / Redo history stack
 */

class Timeline {
  constructor(player) {
    this.player = player;
    this.timelineScroller = document.getElementById('timelineScroller');
    this.trackContainer = document.getElementById('trackContainer');
    this.rulerBar = document.getElementById('rulerBar');
    this.rulerCanvas = document.getElementById('rulerCanvas');
    this.clipsSequencer = document.getElementById('clipsSequencer');
    this.timelinePlayhead = document.getElementById('timelinePlayhead');
    this.timelineHoverGuide = document.getElementById('timelineHoverGuide');
    this.hoverTooltipCard = document.getElementById('hoverTooltipCard');
    this.hoverThumbImg = document.getElementById('hoverThumbImg');
    this.hoverTimecode = document.getElementById('hoverTimecode');

    // Floating Playhead Scrub Preview Card & Needle Elements
    this.playheadThumbPreview = document.getElementById('playheadThumbPreview');
    this.playheadThumbImg = document.getElementById('playheadThumbImg');
    this.playheadLiveBadge = document.getElementById('playheadLiveBadge');

    // In-House Image & Frame Memory Cache for Instant Canvas Filmstrip
    this.imageCache = new Map();
    this.hoverThumbCache = new Map(); // LRU Frame Thumbnail Cache (max 200 items)
    this.hoverRafId = null;
    this.pendingHoverEvent = null;
    this.dragRafId = null;
    this.pendingDragEvent = null;

    // Live Trim Drag Tooltip & Selected Edit Point
    this.trimTooltip = document.getElementById('trimTooltip');
    this.trimBadgeType = document.getElementById('trimBadgeType');
    this.trimBadgeTime = document.getElementById('trimBadgeTime');
    this.trimBadgeDelta = document.getElementById('trimBadgeDelta');
    this.selectedEditPoint = null; // { clipId: string, type: 'start' | 'end' }

    // Magnetic Snapping Guide & Button
    this.btnToggleSnap = document.getElementById('btnToggleSnap');
    this.timelineSnapGuide = document.getElementById('timelineSnapGuide');
    this.snappingEnabled = true;

    // Interactive Clip Reorder Drop Indicator & Live Target Badge
    this.timelineDropIndicator = document.getElementById('timelineDropIndicator');
    this.reorderFloatingBadge = document.getElementById('reorderFloatingBadge');
    this.reorderBadgeText = document.getElementById('reorderBadgeText');
    this.isReorderingClip = false;

    // Timeline Zoom (Time Scale / Detail Level)
    this.zoomLevel = 1.0;
    this.timelineTrackContent = document.getElementById('timelineTrackContent');
    this.timelineZoomControl = document.getElementById('timelineZoomControl');
    this.timelineZoomSlider = document.getElementById('timelineZoomSlider');
    this.timelineZoomDisplay = document.getElementById('timelineZoomDisplay');
    this.btnZoomInTimeline = document.getElementById('btnZoomInTimeline');
    this.btnZoomOutTimeline = document.getElementById('btnZoomOutTimeline');
    this.btnZoomFitTimeline = document.getElementById('btnZoomFitTimeline');

    this.segmentsCardsList = document.getElementById('segmentsCardsList');
    this.summaryDurationText = document.getElementById('summaryDurationText');
    this.summaryClipsCount = document.getElementById('summaryClipsCount');
    this.shortsCapBadge = document.getElementById('shortsCapBadge');

    this.btnUndoAction = document.getElementById('btnUndoAction');
    this.btnRedoAction = document.getElementById('btnRedoAction');

    this.sourceDuration = 0; // Total raw source video length
    this.totalDuration = 0;  // Total sequence duration of all kept clips combined
    this.segments = [];      // [{ id, start, end, name }]
    this.activeClipId = null;
    this.thumbnails = [];

    this.history = [];
    this.historyIdx = -1;
    this.isDraggingPlayhead = false;
    this.wasPlayingBeforeDrag = false;
    this.isTrimming = false;

    this.initEvents();
  }

  initEvents() {
    if (this.btnToggleSnap) {
      this.btnToggleSnap.addEventListener('click', () => this.toggleSnapping());
    }

    // 1. Unified Scrub / Drag for Track Container & Ruler Bar
    const startScrub = (e) => {
      if (this.totalDuration <= 0 || this.segments.length === 0) return;
      if (e.target.classList.contains('trim-drag-handle') || e.target.closest('.trim-drag-handle')) return;
      if (e.target.classList.contains('timeline-clip-card') || e.target.closest('.timeline-clip-card')) return;

      this.selectedEditPoint = null;
      this.highlightActive();

      this.isDraggingPlayhead = true;
      this.dragTrackRect = this.clipsSequencer.getBoundingClientRect();
      this.timelinePlayhead.classList.add('is-dragging');
      this.wasPlayingBeforeDrag = !this.player.video.paused;
      if (this.wasPlayingBeforeDrag) {
        this.player.pause();
      }

      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';

      if (this.timelineHoverGuide) {
        this.timelineHoverGuide.style.display = 'none';
      }

      this.seekToScreenPos(e, true);
    };

    this.rulerBar.addEventListener('mousedown', startScrub);
    this.trackContainer.addEventListener('mousedown', startScrub);

    // 2. Playhead Needle Direct Drag (Pin, Line, and Grab Hitbox)
    this.timelinePlayhead.addEventListener('mousedown', (e) => {
      if (this.totalDuration <= 0) return;
      e.stopPropagation();
      startScrub(e);
    });

    // 3. Global Mouse Move for Butter-Smooth RAF Drag Scrubbing & Hover Tooltip
    window.addEventListener('mousemove', (e) => {
      if (this.isDraggingPlayhead) {
        e.preventDefault();
        this.pendingDragEvent = e;
        if (!this.dragRafId) {
          this.dragRafId = requestAnimationFrame(() => {
            this.dragRafId = null;
            if (this.pendingDragEvent) {
              this.seekToScreenPos(this.pendingDragEvent, true);
            }
          });
        }
      } else {
        this.handleTimelineHover(e);
      }
    }, { passive: false });

    // 4. Global Mouse Up to Finish Drag Scrubbing
    window.addEventListener('mouseup', (e) => {
      if (this.dragRafId) {
        cancelAnimationFrame(this.dragRafId);
        this.dragRafId = null;
      }
      this.pendingDragEvent = null;
      if (this.timelineSnapGuide) {
        this.timelineSnapGuide.style.display = 'none';
      }
      if (this.isDraggingPlayhead) {
        this.isDraggingPlayhead = false;
        this.timelinePlayhead.classList.remove('is-dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';

        // Final precise seek on release
        this.seekToScreenPos(e, false);
        this.dragTrackRect = null;

        if (this.wasPlayingBeforeDrag) {
          this.player.play();
        }
      }
    });

    // 5. Hide hover guide when mouse leaves timeline
    this.timelineScroller.addEventListener('mouseleave', () => {
      if (!this.isDraggingPlayhead && this.timelineHoverGuide) {
        this.timelineHoverGuide.style.display = 'none';
      }
    });

    // Action buttons with button blur to prevent keyboard spacebar conflict
    document.getElementById('btnSplitClip').addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.splitAtPlayhead();
    });
    document.getElementById('btnTrimIn').addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.trimStartToPlayhead();
    });
    document.getElementById('btnTrimOut').addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.trimEndToPlayhead();
    });
    document.getElementById('btnDeleteClip').addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.deleteActiveClip();
    });
    const btnAddClip = document.getElementById('btnAddClip');
    if (btnAddClip) {
      btnAddClip.addEventListener('click', (e) => {
        e.currentTarget.blur();
        this.addNewClip();
      });
    }
    const btnAddClipBtn = document.getElementById('btnAddClipBtn');
    if (btnAddClipBtn) {
      btnAddClipBtn.addEventListener('click', (e) => {
        e.currentTarget.blur();
        this.addNewClip();
      });
    }

    this.btnUndoAction.addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.undo();
    });
    this.btnRedoAction.addEventListener('click', (e) => {
      e.currentTarget.blur();
      this.redo();
    });

    // Timeline Zoom Controls (Zoom In, Zoom Out, Fit, Time Scale Slider)
    if (this.btnZoomInTimeline) {
      this.btnZoomInTimeline.addEventListener('click', (e) => {
        e.currentTarget.blur();
        this.zoomIn();
      });
    }
    if (this.btnZoomOutTimeline) {
      this.btnZoomOutTimeline.addEventListener('click', (e) => {
        e.currentTarget.blur();
        this.zoomOut();
      });
    }
    if (this.btnZoomFitTimeline) {
      this.btnZoomFitTimeline.addEventListener('click', (e) => {
        e.currentTarget.blur();
        this.zoomFit();
      });
    }
    if (this.timelineZoomSlider) {
      this.timelineZoomSlider.addEventListener('input', (e) => {
        this.setZoomLevel(parseFloat(e.target.value));
      });
    }

    // Zoom via Alt+Wheel or Ctrl+Wheel over Timeline or Ruler
    if (this.timelineScroller) {
      this.timelineScroller.addEventListener('wheel', (e) => {
        if (e.altKey || e.ctrlKey) {
          e.preventDefault();
          const zoomDelta = e.deltaY < 0 ? 0.35 : -0.35;
          this.setZoomLevel(this.zoomLevel + zoomDelta);
        }
      }, { passive: false });
    }

    window.addEventListener('resize', () => {
      this.render();
    });
  }

  loadVideo(meta) {
    this.sourceDuration = meta.duration || 10;
    const streamUri = meta.sourceUri || (meta.filePath && !meta.filePath.startsWith('blob:')
      ? `/api/stream?path=${encodeURIComponent(meta.filePath)}`
      : meta.filePath);

    const firstSeg = {
      id: 'clip_0',
      start: 0,
      end: this.sourceDuration,
      name: meta.fileName || 'Clip 1',
      sourcePath: meta.filePath || meta.fileName,
      sourceUri: streamUri,
      sourceDuration: this.sourceDuration,
      thumbnails: []
    };

    this.segments = [firstSeg];
    this.activeClipId = 'clip_0';
    this.selectedEditPoint = null;
    this.thumbnails = [];

    this.timelinePlayhead.style.display = 'block';

    this.history = [];
    this.historyIdx = -1;
    this.recalculateSequenceDuration();
    this.pushHistory();

    this.render();

    // Fetch filmstrip thumbnails for first clip
    if (meta.filePath && !meta.filePath.startsWith('blob:')) {
      fetch(`/api/thumbnails?path=${encodeURIComponent(meta.filePath)}&count=36`)
        .then(r => r.json())
        .then(d => {
          if (d && d.thumbnails && d.thumbnails.length > 0) {
            this.thumbnails = d.thumbnails;
            firstSeg.thumbnails = d.thumbnails;
            d.thumbnails.forEach(u => this.getCachedImage(u));
            this.drawAllFilmstrips();
          }
        })
        .catch(e => console.log('Thumbnail fetch note:', e));
    }
    this.extractInHouseThumbnails(firstSeg, 24);
  }

  addVideoClip(meta, append = true) {
    const dur = meta.duration || 10;
    const clipId = `clip_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
    const streamUri = meta.sourceUri || (meta.filePath && !meta.filePath.startsWith('blob:')
      ? `/api/stream?path=${encodeURIComponent(meta.filePath)}`
      : meta.filePath);
    const clipName = meta.fileName || `Clip ${this.segments.length + 1}`;

    const newSeg = {
      id: clipId,
      start: 0,
      end: dur,
      sourcePath: meta.filePath || meta.fileName,
      sourceUri: streamUri,
      sourceDuration: dur,
      name: clipName,
      thumbnails: []
    };

    if (append) {
      this.segments.push(newSeg);
    } else {
      const activeIdx = this.segments.findIndex(s => s.id === this.activeClipId);
      if (activeIdx !== -1) {
        this.segments.splice(activeIdx + 1, 0, newSeg);
      } else {
        this.segments.push(newSeg);
      }
    }

    this.activeClipId = clipId;
    this.selectedEditPoint = null;
    this.recalculateSequenceDuration();
    this.pushHistory();
    this.render();
    this.showTimelineNotice(`Added "${clipName}" to sequence`);

    // Fetch filmstrip thumbnails for the added video
    if (meta.filePath && !meta.filePath.startsWith('blob:')) {
      fetch(`/api/thumbnails?path=${encodeURIComponent(meta.filePath)}&count=36`)
        .then(r => r.json())
        .then(d => {
          if (d && d.thumbnails && d.thumbnails.length > 0) {
            newSeg.thumbnails = d.thumbnails;
            d.thumbnails.forEach(u => this.getCachedImage(u));
            this.drawAllFilmstrips();
          }
        })
        .catch(() => {});
    }
    this.extractInHouseThumbnails(newSeg, 24);
  }

  recalculateSequenceDuration() {
    this.totalDuration = this.segments.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
  }

  pushHistory() {
    if (this.historyIdx < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyIdx + 1);
    }
    // High-performance snapshot: Avoid stringifying megabytes of base64 thumbnail arrays
    const snapshotSegments = this.segments.map(s => ({ ...s }));
    this.history.push({
      segments: snapshotSegments,
      activeClipId: this.activeClipId
    });
    // Cap history to 30 states to keep memory footprint light
    if (this.history.length > 30) {
      this.history.shift();
    }
    this.historyIdx = this.history.length - 1;
    this.updateHistoryButtons();
  }

  undo() {
    if (this.historyIdx > 0) {
      this.historyIdx--;
      const s = this.history[this.historyIdx];
      this.segments = s.segments.map(seg => ({ ...seg }));
      this.activeClipId = s.activeClipId;
      this.selectedEditPoint = null;
      this.recalculateSequenceDuration();
      this.render();
      this.updateHistoryButtons();

      if (this.activeClipId) {
        const seg = this.segments.find(x => x.id === this.activeClipId);
        if (seg) {
          if (seg.sourceUri && this.player.currentSourceUri !== seg.sourceUri) {
            this.player.switchSource(seg.sourceUri, seg.start, false);
          } else {
            this.player.seek(seg.start);
          }
        }
      }
      this.showTimelineNotice("Undo [Ctrl+Z]");
    }
  }

  redo() {
    if (this.historyIdx < this.history.length - 1) {
      this.historyIdx++;
      const s = this.history[this.historyIdx];
      this.segments = s.segments.map(seg => ({ ...seg }));
      this.activeClipId = s.activeClipId;
      this.selectedEditPoint = null;
      this.recalculateSequenceDuration();
      this.render();
      this.updateHistoryButtons();

      if (this.activeClipId) {
        const seg = this.segments.find(x => x.id === this.activeClipId);
        if (seg) {
          if (seg.sourceUri && this.player.currentSourceUri !== seg.sourceUri) {
            this.player.switchSource(seg.sourceUri, seg.start, false);
          } else {
            this.player.seek(seg.start);
          }
        }
      }
      this.showTimelineNotice("Redo [Ctrl+Y]");
    }
  }

  updateHistoryButtons() {
    this.btnUndoAction.disabled = this.historyIdx <= 0;
    this.btnRedoAction.disabled = this.historyIdx >= this.history.length - 1;
  }

  getTrackWidth() {
    if (this.clipsSequencer && this.clipsSequencer.clientWidth > 0) {
      return this.clipsSequencer.clientWidth;
    }
    const scrollerW = this.timelineScroller ? this.timelineScroller.clientWidth : (window.innerWidth - 40);
    const baseW = Math.max(200, scrollerW - 40);
    return Math.round(baseW * (this.zoomLevel || 1.0));
  }

  /**
   * Called by VideoPlayer 60 FPS loop & timeupdate event
   */
  onPlayerTimeUpdate(sourceTime) {
    if (this.totalDuration <= 0 || this.segments.length === 0 || this.isTrimming) return;

    const curUri = this.player.currentSourceUri;
    let targetSeg = null;
    let targetAcc = 0;

    // 1. If activeClipId is set and matches current sourceTime, keep playhead anchored in active clip!
    if (this.activeClipId) {
      let acc = 0;
      for (let i = 0; i < this.segments.length; i++) {
        const seg = this.segments[i];
        const dur = Math.max(0, seg.end - seg.start);
        if (seg.id === this.activeClipId) {
          const uriMatches = !curUri || !seg.sourceUri || seg.sourceUri === curUri;
          if (uriMatches && sourceTime >= (seg.start - 0.05) && sourceTime <= (seg.end + 0.05)) {
            targetSeg = seg;
            targetAcc = acc;
            break;
          }
        }
        acc += dur;
      }
    }

    // 2. If not matched in active clip, scan sequence clips matching current source container
    if (!targetSeg) {
      let acc = 0;
      for (let i = 0; i < this.segments.length; i++) {
        const seg = this.segments[i];
        const dur = Math.max(0, seg.end - seg.start);
        const uriMatches = !curUri || !seg.sourceUri || seg.sourceUri === curUri;
        const isLast = (i === this.segments.length - 1);
        const inClip = isLast
          ? (sourceTime >= (seg.start - 0.03) && sourceTime <= (seg.end + 0.05))
          : (sourceTime >= (seg.start - 0.03) && sourceTime < seg.end);

        if (uriMatches && inClip) {
          targetSeg = seg;
          targetAcc = acc;
          if (this.activeClipId !== seg.id) {
            this.activeClipId = seg.id;
            this.highlightActive();
          }
          break;
        }
        acc += dur;
      }
    }

    if (targetSeg) {
      const dur = Math.max(0, targetSeg.end - targetSeg.start);
      const clampedSourceTime = Math.max(targetSeg.start, Math.min(targetSeg.end, sourceTime));
      const offsetInClip = clampedSourceTime - targetSeg.start;
      const seqTime = targetAcc + offsetInClip;
      const pct = Math.max(0, Math.min(1, seqTime / this.totalDuration));

      if (!this.isDraggingPlayhead) {
        const trackWidth = this.getTrackWidth();
        const leftPx = 20 + (pct * trackWidth);
        this.timelinePlayhead.style.left = `${leftPx}px`;

        if (this.zoomLevel > 1.0 && !this.player.video.paused) {
          this.ensurePlayheadVisible(leftPx);
        }
      }

      this.player.timeCurrent.textContent = this.player.formatTimecode(seqTime);
      this.player.timeTotal.textContent = this.player.formatTimecode(this.totalDuration);
      const liveBadge = document.getElementById('playheadLiveBadge');
      if (liveBadge) {
        liveBadge.textContent = this.player.formatTimecode(seqTime);
      }
    } else if (!this.isDraggingPlayhead) {
      // Fallback nearest boundary for valid display
      let closestSeqTime = 0;
      let minDiff = Infinity;
      let accDur = 0;
      for (const seg of this.segments) {
        const uriMatches = !curUri || !seg.sourceUri || seg.sourceUri === curUri;
        if (uriMatches) {
          if (Math.abs(sourceTime - seg.start) < minDiff) {
            minDiff = Math.abs(sourceTime - seg.start);
            closestSeqTime = accDur;
          }
          if (Math.abs(sourceTime - seg.end) < minDiff) {
            minDiff = Math.abs(sourceTime - seg.end);
            closestSeqTime = accDur + (seg.end - seg.start);
          }
        }
        accDur += (seg.end - seg.start);
      }
      this.player.timeCurrent.textContent = this.player.formatTimecode(closestSeqTime);
      this.player.timeTotal.textContent = this.player.formatTimecode(this.totalDuration);

      const pct = Math.max(0, Math.min(1, closestSeqTime / this.totalDuration));
      const trackWidth = this.getTrackWidth();
      const leftPx = 20 + (pct * trackWidth);
      this.timelinePlayhead.style.left = `${leftPx}px`;
      if (this.zoomLevel > 1.0 && !this.player.video.paused) {
        this.ensurePlayheadVisible(leftPx);
      }
      const liveBadge = document.getElementById('playheadLiveBadge');
      if (liveBadge) {
        liveBadge.textContent = this.player.formatTimecode(closestSeqTime);
      }
    }
  }

  /**
   * Live Hover Preview Guide & Tooltip tracking (Debounced via RAF + LRU Cache)
   */
  handleTimelineHover(e) {
    if (!this.timelineHoverGuide || this.totalDuration <= 0 || this.segments.length === 0 || this.isDraggingPlayhead || this.isTrimming) {
      if (this.timelineHoverGuide) this.timelineHoverGuide.style.display = 'none';
      return;
    }

    const scrollerRect = this.timelineScroller.getBoundingClientRect();
    if (e.clientY < (scrollerRect.top - 10) || e.clientY > (scrollerRect.bottom + 10) || e.clientX < scrollerRect.left || e.clientX > scrollerRect.right) {
      this.timelineHoverGuide.style.display = 'none';
      return;
    }

    this.pendingHoverEvent = { clientX: e.clientX, clientY: e.clientY };
    if (!this.hoverRafId) {
      this.hoverRafId = requestAnimationFrame(() => {
        this.hoverRafId = null;
        if (this.pendingHoverEvent) {
          this.renderHoverGuide(this.pendingHoverEvent);
        }
      });
    }
  }

  renderHoverGuide(e) {
    if (!this.timelineHoverGuide || this.totalDuration <= 0 || this.segments.length === 0) return;

    const rect = this.clipsSequencer.getBoundingClientRect();
    const trackWidth = Math.max(1, rect.width);
    const clickX = Math.max(0, Math.min(trackWidth, e.clientX - rect.left));
    const pct = Math.max(0, Math.min(1, clickX / trackWidth));
    const targetSeqTime = pct * this.totalDuration;

    // Show and position hover guide
    this.timelineHoverGuide.style.display = 'flex';
    this.timelineHoverGuide.style.left = `${20 + clickX}px`;

    // Calculate source time & segment for preview
    let acc = 0;
    let sourceTime = 0;
    let targetSeg = null;
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      const dur = seg.end - seg.start;
      if (targetSeqTime <= (acc + dur) || i === this.segments.length - 1) {
        const offsetInClip = Math.max(0, Math.min(dur, targetSeqTime - acc));
        sourceTime = seg.start + offsetInClip;
        targetSeg = seg;
        break;
      }
      acc += dur;
    }

    // Timecode display
    this.hoverTimecode.textContent = this.player.formatTimecode(targetSeqTime);

    // Frame thumbnail display with LRU In-Memory Cache (200 items)
    const clipThumbs = (targetSeg && targetSeg.thumbnails && targetSeg.thumbnails.length > 0) ? targetSeg.thumbnails : this.thumbnails;
    const clipSrcDur = (targetSeg && targetSeg.sourceDuration) || this.sourceDuration || 1;
    if (clipThumbs && clipThumbs.length > 0) {
      const thumbIdx = Math.min(
        clipThumbs.length - 1,
        Math.max(0, Math.floor((sourceTime / clipSrcDur) * clipThumbs.length))
      );
      const cacheKey = `${targetSeg ? targetSeg.id : 'base'}_${thumbIdx}`;
      let thumbUrl = this.hoverThumbCache.get(cacheKey);
      if (!thumbUrl) {
        thumbUrl = clipThumbs[thumbIdx];
        if (this.hoverThumbCache.size >= 200) {
          const oldestKey = this.hoverThumbCache.keys().next().value;
          this.hoverThumbCache.delete(oldestKey);
        }
        this.hoverThumbCache.set(cacheKey, thumbUrl);
      }
      this.hoverThumbImg.src = thumbUrl;
      this.hoverThumbImg.style.display = 'block';
    } else {
      this.hoverThumbImg.style.display = 'none';
    }
  }

  toggleSnapping(force) {
    this.snappingEnabled = force !== undefined ? force : !this.snappingEnabled;
    if (this.btnToggleSnap) {
      this.btnToggleSnap.classList.toggle('active', this.snappingEnabled);
    }
  }

  getSnapTime(rawSeqTime, snapTolerancePx = 4) {
    if (!this.snappingEnabled || this.totalDuration <= 0) {
      return { time: rawSeqTime, isSnapped: false };
    }

    const trackWidth = this.getTrackWidth();
    // Cap snap threshold in seconds to at most 0.05 seconds (approx 3 frames at 60fps)
    // so it NEVER creates multi-second dead zones or skipping jumps!
    const snapTolSec = Math.min(0.05, (snapTolerancePx / trackWidth) * this.totalDuration);

    // Only snap to INTERIOR clip boundaries (between clips) - NEVER to 0 or totalDuration!
    const snapPoints = [];
    let acc = 0;
    for (let i = 0; i < this.segments.length - 1; i++) {
      const seg = this.segments[i];
      acc += (seg.end - seg.start);
      snapPoints.push(acc);
    }

    let closest = null;
    let minDiff = Infinity;
    for (const pt of snapPoints) {
      const diff = Math.abs(rawSeqTime - pt);
      if (diff < snapTolSec && diff < minDiff) {
        minDiff = diff;
        closest = pt;
      }
    }

    if (closest !== null) {
      return { time: closest, isSnapped: true };
    }
    return { time: rawSeqTime, isSnapped: false };
  }

  getCurrentSequenceTime() {
    if (this.totalDuration <= 0 || this.segments.length === 0) return 0;
    const curSource = this.player.video.currentTime || 0;
    const curUri = this.player.currentSourceUri;

    // 1. If activeClipId is set and matches current video position, use it directly!
    if (this.activeClipId) {
      let acc = 0;
      for (let i = 0; i < this.segments.length; i++) {
        const seg = this.segments[i];
        const dur = Math.max(0, seg.end - seg.start);
        if (seg.id === this.activeClipId) {
          const uriMatches = !curUri || !seg.sourceUri || seg.sourceUri === curUri;
          if (uriMatches && curSource >= (seg.start - 0.05) && curSource <= (seg.end + 0.05)) {
            const offset = Math.max(0, Math.min(dur, curSource - seg.start));
            return acc + offset;
          }
        }
        acc += dur;
      }
    }

    // 2. Otherwise scan clips matching current source container
    let acc = 0;
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      const dur = Math.max(0, seg.end - seg.start);
      const uriMatches = !curUri || !seg.sourceUri || seg.sourceUri === curUri;
      const isLast = (i === this.segments.length - 1);
      const inClip = isLast
        ? (curSource >= (seg.start - 0.05) && curSource <= (seg.end + 0.05))
        : (curSource >= (seg.start - 0.05) && curSource < seg.end);

      if (uriMatches && inClip) {
        const offset = Math.max(0, Math.min(dur, curSource - seg.start));
        return acc + offset;
      }
      acc += dur;
    }
    return 0;
  }

  seekToSequenceTime(targetSeqTime, isFast = false) {
    if (this.totalDuration <= 0 || this.segments.length === 0) return;
    const clampedSeq = Math.max(0, Math.min(this.totalDuration, targetSeqTime));
    const trackWidth = this.getTrackWidth();
    const pct = this.totalDuration > 0 ? (clampedSeq / this.totalDuration) : 0;
    const playheadPx = 20 + (pct * trackWidth);

    this.timelinePlayhead.style.left = `${playheadPx}px`;

    const liveBadge = document.getElementById('playheadLiveBadge');
    if (liveBadge) {
      liveBadge.textContent = this.player.formatTimecode(clampedSeq);
    }

    let acc = 0;
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      const dur = seg.end - seg.start;
      if (clampedSeq <= (acc + dur) || i === this.segments.length - 1) {
        const offsetInClip = Math.max(0, Math.min(dur, clampedSeq - acc));
        const sourceTime = seg.start + offsetInClip;

        if (this.activeClipId !== seg.id) {
          this.activeClipId = seg.id;
          this.highlightActive();
        }

        // Update live scrub preview frame & timecode directly on the needle
        if (this.playheadLiveBadge) {
          this.playheadLiveBadge.textContent = this.player.formatTimecode(clampedSeq);
        }
        const clipThumbs = (seg && seg.thumbnails && seg.thumbnails.length > 0) ? seg.thumbnails : this.thumbnails;
        const clipSrcDur = (seg && seg.sourceDuration) || this.sourceDuration || 1;
        if (this.playheadThumbImg && clipThumbs && clipThumbs.length > 0) {
          const thumbIdx = Math.min(
            clipThumbs.length - 1,
            Math.max(0, Math.floor((sourceTime / clipSrcDur) * clipThumbs.length))
          );
          if (this.playheadThumbImg.src !== clipThumbs[thumbIdx]) {
            this.playheadThumbImg.src = clipThumbs[thumbIdx];
          }
          this.playheadThumbImg.style.display = 'block';
        } else if (this.playheadThumbImg) {
          this.playheadThumbImg.style.display = 'none';
        }

        // Seamless multi-video file preview!
        if (seg.sourceUri && this.player.currentSourceUri !== seg.sourceUri) {
          this.player.switchSource(seg.sourceUri, sourceTime, !this.player.video.paused);
        } else {
          this.player.seek(sourceTime, isFast);
        }

        this.player.timeCurrent.textContent = this.player.formatTimecode(clampedSeq);
        this.player.timeTotal.textContent = this.player.formatTimecode(this.totalDuration);
        return;
      }
      acc += dur;
    }
  }

  /**
   * Convert screen click position into sequence timestamp and seek video in real time
   */
  seekToScreenPos(e, isFast = false) {
    if (this.totalDuration <= 0 || this.segments.length === 0) return;

    // Use current bounding rect to handle dynamic horizontal scrolling smoothly
    const rect = this.clipsSequencer.getBoundingClientRect();
    const trackWidth = Math.max(1, rect.width);
    const clickX = Math.max(0, Math.min(trackWidth, e.clientX - rect.left));
    const rawPct = Math.max(0, Math.min(1, clickX / trackWidth));
    const rawTargetSeqTime = rawPct * this.totalDuration;

    // Apply Magnetic Snapping (Interior clip cuts only, micro-frame tolerance)
    const snapResult = this.getSnapTime(rawTargetSeqTime, 4);
    const targetSeqTime = snapResult.time;
    const finalPct = this.totalDuration > 0 ? (targetSeqTime / this.totalDuration) : 0;
    const playheadPx = 20 + (finalPct * trackWidth);

    // Immediately update visual playhead position
    this.timelinePlayhead.style.left = `${playheadPx}px`;

    // Snap line indicator
    if (this.timelineSnapGuide) {
      if (snapResult.isSnapped) {
        this.timelineSnapGuide.style.display = 'block';
        this.timelineSnapGuide.style.left = `${playheadPx}px`;
      } else {
        this.timelineSnapGuide.style.display = 'none';
      }
    }

    // Edge panning when dragging playhead at the boundaries of the scroller
    if (this.zoomLevel > 1.0 && this.isDraggingPlayhead && this.timelineScroller) {
      const scrollerRect = this.timelineScroller.getBoundingClientRect();
      if (e.clientX > scrollerRect.right - 40) {
        this.timelineScroller.scrollLeft += 15;
      } else if (e.clientX < scrollerRect.left + 40) {
        this.timelineScroller.scrollLeft -= 15;
      }
    }

    this.seekToSequenceTime(targetSeqTime, isFast);
  }

  // =========================================================
  // ACTIONS: SPLIT, IN, OUT, DELETE, ADD
  // =========================================================

  splitAtPlayhead() {
    if (this.totalDuration <= 0 || this.segments.length === 0) return;

    const wasPlaying = !this.player.video.paused;
    if (wasPlaying) {
      this.player.pause();
    }

    const curSourceTime = this.player.video.currentTime;
    const curUri = this.player.currentSourceUri;

    let targetIdx = -1;
    let offsetInClip = 0;

    // 1. Priority A: Match active clip if playhead is within its boundaries
    if (this.activeClipId) {
      const idx = this.segments.findIndex(s => s.id === this.activeClipId);
      if (idx !== -1) {
        const s = this.segments[idx];
        const uriMatches = !curUri || !s.sourceUri || s.sourceUri === curUri;
        if (uriMatches && curSourceTime >= (s.start - 0.04) && curSourceTime <= (s.end + 0.04)) {
          targetIdx = idx;
          offsetInClip = Math.max(0, Math.min(s.end - s.start, curSourceTime - s.start));
        }
      }
    }

    // 2. Priority B: Scan clips matching video's current file & time
    if (targetIdx === -1) {
      for (let i = 0; i < this.segments.length; i++) {
        const s = this.segments[i];
        const uriMatches = !curUri || !s.sourceUri || s.sourceUri === curUri;
        if (uriMatches && curSourceTime >= s.start && curSourceTime <= s.end) {
          targetIdx = i;
          offsetInClip = Math.max(0, Math.min(s.end - s.start, curSourceTime - s.start));
          break;
        }
      }
    }

    // 3. Priority C: Fallback to sequence position
    if (targetIdx === -1) {
      const seqTime = this.getCurrentSequenceTime();
      let acc = 0;
      for (let i = 0; i < this.segments.length; i++) {
        const s = this.segments[i];
        const dur = Math.max(0, s.end - s.start);
        if (seqTime >= acc && (seqTime < acc + dur || i === this.segments.length - 1)) {
          targetIdx = i;
          offsetInClip = Math.max(0, Math.min(dur, seqTime - acc));
          break;
        }
        acc += dur;
      }
    }

    if (targetIdx === -1) {
      this.showTimelineNotice("Move playhead inside a clip to split [S]");
      if (wasPlaying) this.player.play();
      return;
    }

    const seg = this.segments[targetIdx];
    const clipDur = seg.end - seg.start;
    const minMargin = Math.max(0.04, 1 / (this.player.fps || 60));

    // Reject cuts right at clip edges to prevent microscopic sliver clips
    if (offsetInClip <= minMargin || offsetInClip >= (clipDur - minMargin)) {
      this.showTimelineNotice("Playhead is at clip cut point. Move playhead inside clip to split [S]");
      if (wasPlaying) this.player.play();
      return;
    }

    const splitTime = Math.round((seg.start + offsetInClip) * 1000) / 1000;
    const newIdA = seg.id;
    const newIdB = `clip_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

    const cleanBaseName = seg.name ? seg.name.replace(/ \(Part \d+\)$/, '') : `Clip ${targetIdx + 1}`;
    const segA = {
      ...seg,
      id: newIdA,
      start: seg.start,
      end: splitTime,
      name: `${cleanBaseName} (Part 1)`
    };

    const segB = {
      ...seg,
      id: newIdB,
      start: splitTime,
      end: seg.end,
      name: `${cleanBaseName} (Part 2)`
    };

    // Splice split clips into sequence
    this.segments.splice(targetIdx, 1, segA, segB);
    this.activeClipId = newIdB;
    this.selectedEditPoint = null;

    this.recalculateSequenceDuration();
    this.pushHistory();
    this.render();

    // Lock playhead position directly on presentation time without issuing a jarring seek
    this.onPlayerTimeUpdate(curSourceTime);
    this.showTimelineNotice("Split clip into two parts [S]");

    if (wasPlaying) {
      this.player.play();
    }
  }

  showTimelineNotice(msg) {
    let noticeEl = document.getElementById('timelineActionNotice');
    if (!noticeEl) {
      noticeEl = document.createElement('div');
      noticeEl.id = 'timelineActionNotice';
      noticeEl.className = 'timeline-action-notice';
      if (this.timelineScroller) {
        this.timelineScroller.appendChild(noticeEl);
      }
    }
    noticeEl.textContent = msg;
    noticeEl.classList.add('visible');
    if (this._noticeTimeout) clearTimeout(this._noticeTimeout);
    this._noticeTimeout = setTimeout(() => {
      noticeEl.classList.remove('visible');
    }, 1800);
  }

  /**
   * Select a clip end (Start or End handle) to control the timeline
   */
  selectClipEnd(clipId, type) {
    this.activeClipId = clipId;
    this.selectedEditPoint = { clipId, type };
    this.highlightActive();

    const seg = this.segments.find(s => s.id === clipId);
    if (!seg) return;

    let acc = 0;
    for (const s of this.segments) {
      if (s.id === clipId) {
        const pointSec = acc + (type === 'start' ? 0 : (s.end - s.start));
        const targetSourceTime = type === 'start' ? seg.start : seg.end;
        this.player.seek(targetSourceTime, false);
        this.player.timeCurrent.textContent = this.player.formatTimecode(pointSec);
        this.player.timeTotal.textContent = this.player.formatTimecode(this.totalDuration);

        const trackWidth = this.getTrackWidth();
        const pct = this.totalDuration > 0 ? pointSec / this.totalDuration : 0;
        this.timelinePlayhead.style.left = `${20 + (pct * trackWidth)}px`;
        break;
      }
      acc += (s.end - s.start);
    }
  }

  /**
   * Nudge selected clip end frame-by-frame for surgical keyboard & button control
   */
  nudgeSelectedEditPoint(deltaFrames) {
    if (!this.selectedEditPoint || this.totalDuration <= 0) return;
    const seg = this.segments.find(s => s.id === this.selectedEditPoint.clipId);
    if (!seg) return;

    const fps = this.player.fps || 60;
    const deltaSec = deltaFrames / fps;

    if (this.selectedEditPoint.type === 'start') {
      const newStart = Math.max(0, Math.min(seg.end - 0.05, seg.start + deltaSec));
      if (Math.abs(newStart - seg.start) > 0.0001) {
        seg.start = newStart;
        this.recalculateSequenceDuration();
        this.render();
        this.selectClipEnd(seg.id, 'start');
        this.player.seek(newStart, true);
        this.debounceNudgeHistory();
      }
    } else {
      const maxEnd = seg.sourceDuration || this.sourceDuration || 10;
      const newEnd = Math.min(maxEnd, Math.max(seg.start + 0.05, seg.end + deltaSec));
      if (Math.abs(newEnd - seg.end) > 0.0001) {
        seg.end = newEnd;
        this.recalculateSequenceDuration();
        this.render();
        this.selectClipEnd(seg.id, 'end');
        this.player.seek(newEnd, true);
        this.debounceNudgeHistory();
      }
    }
  }

  debounceNudgeHistory() {
    if (this._nudgeHistoryTimer) clearTimeout(this._nudgeHistoryTimer);
    this._nudgeHistoryTimer = setTimeout(() => {
      this._nudgeHistoryTimer = null;
      this.pushHistory();
    }, 400);
  }

  trimStartToPlayhead() {
    if (this.totalDuration <= 0) return;
    const clipId = this.selectedEditPoint ? this.selectedEditPoint.clipId : this.activeClipId;
    if (!clipId) return;
    const time = this.player.video.currentTime;
    const seg = this.segments.find(s => s.id === clipId);
    if (!seg) return;

    const frameMargin = Math.max(0.016, 1 / (this.player.fps || 60));
    if (time > seg.start && time < (seg.end - frameMargin)) {
      seg.start = time;
      this.recalculateSequenceDuration();
      this.pushHistory();
      this.render();
      this.selectClipEnd(seg.id, 'start');
      this.showTimelineNotice("Trimmed start to playhead [ [ ]");
    } else {
      this.showTimelineNotice("Position playhead inside clip to trim start");
    }
  }

  trimEndToPlayhead() {
    if (this.totalDuration <= 0) return;
    const clipId = this.selectedEditPoint ? this.selectedEditPoint.clipId : this.activeClipId;
    if (!clipId) return;
    const time = this.player.video.currentTime;
    const seg = this.segments.find(s => s.id === clipId);
    if (!seg) return;

    const frameMargin = Math.max(0.016, 1 / (this.player.fps || 60));
    if (time < seg.end && time > (seg.start + frameMargin)) {
      seg.end = time;
      this.recalculateSequenceDuration();
      this.pushHistory();
      this.render();
      this.selectClipEnd(seg.id, 'end');
      this.showTimelineNotice("Trimmed end to playhead [ ] ]");
    } else {
      this.showTimelineNotice("Position playhead inside clip to trim end");
    }
  }

  /**
   * Delete Active Clip -> Completely removes it from the sequence,
   * and the remaining clips immediately ripple and form the NEW complete timeline!
   */
  deleteActiveClip() {
    if (!this.activeClipId) return;
    this.deleteClipById(this.activeClipId);
  }

  deleteClipById(clipId) {
    const idx = this.segments.findIndex(s => s.id === clipId);
    if (idx === -1) return;

    if (this.selectedEditPoint && this.selectedEditPoint.clipId === clipId) {
      this.selectedEditPoint = null;
    }

    // 1. Remove the deleted clip completely
    this.segments.splice(idx, 1);

    // 2. Recalculate the new sequence duration
    this.recalculateSequenceDuration();

    // 3. Set newly active clip and seek
    if (this.segments.length > 0) {
      const nextIdx = Math.min(idx, this.segments.length - 1);
      const nextSeg = this.segments[nextIdx];
      this.activeClipId = nextSeg.id;
      if (nextSeg.sourceUri && this.player.currentSourceUri !== nextSeg.sourceUri) {
        this.player.switchSource(nextSeg.sourceUri, nextSeg.start, false);
      } else {
        this.player.seek(nextSeg.start);
      }
    } else {
      this.activeClipId = null;
    }

    // 4. Push history & re-render the timeline
    this.pushHistory();
    this.render();
  }

  addNewClip() {
    const addInput = document.getElementById('addClipFileInput');
    if (addInput) {
      addInput.click();
    }
  }

  // =========================================================
  // TIMELINE ZOOM & TIME SCALE ENGINE (DETAIL LEVEL)
  // =========================================================

  updateZoomContainer() {
    if (!this.timelineTrackContent) return;
    const scrollerW = (this.timelineScroller ? this.timelineScroller.clientWidth : 0) || (window.innerWidth - 40);
    const zoom = Math.max(1.0, Math.min(10.0, this.zoomLevel || 1.0));
    if (zoom <= 1.01) {
      this.timelineTrackContent.style.width = '100%';
    } else {
      const zoomedW = Math.round(scrollerW * zoom);
      this.timelineTrackContent.style.width = `${zoomedW}px`;
    }
    this.updateZoomUI();
  }

  updateZoomUI() {
    const isFit = (this.zoomLevel || 1.0) <= 1.01;
    if (this.timelineZoomSlider) {
      this.timelineZoomSlider.value = this.zoomLevel || 1.0;
    }
    if (this.timelineZoomDisplay) {
      this.timelineZoomDisplay.textContent = isFit ? '1.0×' : `${this.zoomLevel.toFixed(1)}×`;
    }
    if (this.btnZoomFitTimeline) {
      this.btnZoomFitTimeline.classList.toggle('active', isFit);
      this.btnZoomFitTimeline.title = isFit ? "Timeline Fit to Screen (1.0×)" : `Reset to Fit (Shift+Z) - Currently ${this.zoomLevel.toFixed(1)}×`;
    }
    if (this.btnZoomOutTimeline) {
      this.btnZoomOutTimeline.disabled = isFit;
    }
    if (this.btnZoomInTimeline) {
      this.btnZoomInTimeline.disabled = (this.zoomLevel || 1.0) >= 10.0;
    }
  }

  setZoomLevel(level, anchorSeqTime = null) {
    const prevZoom = this.zoomLevel || 1.0;
    const clamped = Math.max(1.0, Math.min(10.0, Math.round(level * 100) / 100));
    const newZoom = clamped <= 1.02 ? 1.0 : clamped;

    if (Math.abs(prevZoom - newZoom) < 0.01 && this._hasAppliedZoom) return;
    this._hasAppliedZoom = true;

    // Anchor time: preserve current playhead position or viewport center
    const scrollerW = this.timelineScroller ? this.timelineScroller.clientWidth : window.innerWidth - 40;
    const scrollLeft = this.timelineScroller ? this.timelineScroller.scrollLeft : 0;
    const prevTrackW = this.getTrackWidth();

    let targetSeq = anchorSeqTime;
    if (targetSeq === null && this.totalDuration > 0 && prevTrackW > 0) {
      const centerPx = scrollLeft + (scrollerW / 2) - 20;
      targetSeq = Math.max(0, Math.min(this.totalDuration, (centerPx / prevTrackW) * this.totalDuration));
    }

    this.zoomLevel = newZoom;
    this.updateZoomContainer();

    // Re-render ruler and clips with new width
    this.drawRuler();
    this.renderClipsTrack();

    // Re-position playhead
    if (this.totalDuration > 0) {
      this.onPlayerTimeUpdate(this.player.video.currentTime);
    }

    // Scroll to preserve anchor
    if (targetSeq !== null && this.totalDuration > 0 && this.timelineScroller) {
      const newTrackW = this.getTrackWidth();
      const newCenterPx = 20 + ((targetSeq / this.totalDuration) * newTrackW);
      this.timelineScroller.scrollLeft = Math.max(0, newCenterPx - (scrollerW / 2));
    }
  }

  zoomIn() {
    const cur = this.zoomLevel || 1.0;
    const next = cur < 2 ? cur + 0.25 : (cur < 5 ? cur + 0.5 : cur + 1.0);
    this.setZoomLevel(next);
  }

  zoomOut() {
    const cur = this.zoomLevel || 1.0;
    const prev = cur <= 2 ? cur - 0.25 : (cur <= 5 ? cur - 0.5 : cur - 1.0);
    this.setZoomLevel(prev);
  }

  zoomFit() {
    this.setZoomLevel(1.0);
    if (this.timelineScroller) {
      this.timelineScroller.scrollLeft = 0;
    }
    this.showTimelineNotice("Fit Timeline to Window [Shift+Z]");
  }

  ensurePlayheadVisible(leftPx) {
    if (!this.timelineScroller) return;
    const scrollLeft = this.timelineScroller.scrollLeft;
    const viewWidth = this.timelineScroller.clientWidth;
    const margin = 60;
    if (leftPx > (scrollLeft + viewWidth - margin)) {
      this.timelineScroller.scrollLeft = leftPx - viewWidth + margin;
    } else if (leftPx < (scrollLeft + margin)) {
      this.timelineScroller.scrollLeft = Math.max(0, leftPx - margin);
    }
  }

  // =========================================================
  // RENDERING (100% MAGNETIC SEQUENCE TIMELINE)
  // =========================================================

  render() {
    this.recalculateSequenceDuration();
    this.updateZoomContainer();
    this.drawRuler();
    this.renderClipsTrack();
    this.renderSegmentsCards();
    this.updateStats();

    if (this.totalDuration > 0) {
      this.onPlayerTimeUpdate(this.player.video.currentTime);
    }
  }

  drawRuler() {
    const width = this.rulerBar.clientWidth || (window.innerWidth - 40);
    this.rulerCanvas.width = width;
    const ctx = this.rulerCanvas.getContext('2d');
    ctx.clearRect(0, 0, width, 26);

    if (this.totalDuration <= 0) return;

    const usableWidth = width - 40;
    const trackStart = 20;

    // Industry-standard round time division calculation
    const minPixelsBetweenLabels = 90;
    const maxMajorTicks = Math.max(1, Math.floor(usableWidth / minPixelsBetweenLabels));
    const rawStep = this.totalDuration / maxMajorTicks;

    const fps = this.player.fps || 60;
    const fDur = 1 / fps;

    // Standard intervals in seconds down to frame-level when zoomed in
    const NICE_STEPS = [
      fDur, fDur * 2, fDur * 5, fDur * 10,
      0.25, 0.5, 1, 2, 5, 10, 15, 30,
      60, 120, 300, 600, 900, 1800, 3600
    ];

    let step = NICE_STEPS[NICE_STEPS.length - 1];
    for (const candidate of NICE_STEPS) {
      if (candidate >= rawStep) {
        step = candidate;
        break;
      }
    }
    if (rawStep > 3600) {
      step = Math.ceil(rawStep / 3600) * 3600;
    }

    const subStep = step >= 60 ? (step / 4) : (step >= 1 ? (step / 2) : (step / 2));

    ctx.fillStyle = '#8a8a9e';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 1. Draw minor sub-ticks
    ctx.strokeStyle = '#222230';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let t = 0; t <= this.totalDuration; t += subStep) {
      const pct = t / this.totalDuration;
      const x = trackStart + (pct * usableWidth);
      ctx.moveTo(x, 18);
      ctx.lineTo(x, 25);
    }
    ctx.stroke();

    // 2. Draw major ticks and round time labels
    ctx.strokeStyle = '#55556c';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let t = 0; t <= this.totalDuration; t += step) {
      const pct = t / this.totalDuration;
      const x = trackStart + (pct * usableWidth);
      ctx.moveTo(x, 14);
      ctx.lineTo(x, 26);

      const mins = Math.floor(t / 60);
      const secs = Math.floor(t % 60);
      const frames = Math.min(fps - 1, Math.round(((t % 1) * fps)));
      let label;
      if (this.totalDuration >= 3600) {
        const hrs = Math.floor(t / 3600);
        label = `${String(hrs).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      } else if (step < 0.2) {
        label = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}:${String(frames).padStart(2, '0')}f`;
      } else if (step < 1) {
        const ms = Math.floor((t % 1) * 100);
        label = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
      } else {
        label = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      }

      const textX = Math.max(22, Math.min(width - 22, x));
      ctx.fillText(label, textX, 7);
    }
    ctx.stroke();

    // 3. Mark sequence end tick
    const endX = trackStart + usableWidth;
    ctx.strokeStyle = '#757590';
    ctx.beginPath();
    ctx.moveTo(endX, 12);
    ctx.lineTo(endX, 26);
    ctx.stroke();
  }

  renderClipsTrack() {
    this.clipsSequencer.innerHTML = '';

    if (this.totalDuration <= 0 || this.segments.length === 0) {
      this.clipsSequencer.innerHTML = '<div class="timeline-empty-hint">No active clips. Click <strong>+ Add</strong> or press <strong>S</strong> to make a cut.</div>';
      return;
    }

    const totalTrackWidth = this.getTrackWidth();
    let accDuration = 0;

    this.segments.forEach((seg, idx) => {
      const clipDuration = Math.max(0.1, seg.end - seg.start);
      const clipEl = document.createElement('div');
      clipEl.className = `timeline-clip-card ${seg.id === this.activeClipId ? 'active' : ''}`;
      clipEl.dataset.id = seg.id;

      // Calculate width and position as a percentage of the total sequence duration
      const startPct = (accDuration / this.totalDuration) * 100;
      const widthPct = (clipDuration / this.totalDuration) * 100;

      clipEl.style.left = `${startPct}%`;
      clipEl.style.width = `${Math.max(0.5, widthPct)}%`;

      // In-House Hardware-Accelerated Filmstrip Canvas
      const filmCanvas = document.createElement('canvas');
      filmCanvas.className = 'clip-filmstrip-canvas';
      filmCanvas.id = `filmstrip_${seg.id}`;
      clipEl.appendChild(filmCanvas);

      const filmGrad = document.createElement('div');
      filmGrad.className = 'clip-filmstrip-gradient';
      clipEl.appendChild(filmGrad);

      // Clip Label & Duration Badge
      const info = document.createElement('div');
      info.className = 'clip-info-overlay';
      const durSec = clipDuration.toFixed(1);
      info.innerHTML = `
        <span class="clip-label-text">${seg.name || `Clip ${idx + 1}`}</span>
        <span class="clip-duration-text">${durSec}s</span>
      `;
      clipEl.appendChild(info);

      // Left Trim Handle (White pill with grip)
      const isLeftSelected = this.selectedEditPoint && this.selectedEditPoint.clipId === seg.id && this.selectedEditPoint.type === 'start';
      const leftHandle = document.createElement('div');
      leftHandle.className = `trim-drag-handle left ${isLeftSelected ? 'selected' : ''}`;
      leftHandle.title = "Drag to Trim Start, or click to select edit point";
      this.bindHandle(leftHandle, seg, 'start', clipEl);
      clipEl.appendChild(leftHandle);

      // Right Trim Handle
      const isRightSelected = this.selectedEditPoint && this.selectedEditPoint.clipId === seg.id && this.selectedEditPoint.type === 'end';
      const rightHandle = document.createElement('div');
      rightHandle.className = `trim-drag-handle right ${isRightSelected ? 'selected' : ''}`;
      rightHandle.title = "Drag to Trim End, or click to select edit point";
      this.bindHandle(rightHandle, seg, 'end', clipEl);
      clipEl.appendChild(rightHandle);

      // Interactive Direct Timeline Clip Reordering & Selection
      this.bindClipReorder(clipEl, seg, idx);

      this.clipsSequencer.appendChild(clipEl);
      accDuration += clipDuration;

      // Draw high-resolution in-house filmstrip frames on canvas
      requestAnimationFrame(() => {
        this.drawClipFilmstrip(filmCanvas, seg, clipDuration, totalTrackWidth);
      });
    });
  }

  // =========================================================
  // IN-HOUSE CANVAS FILMSTRIP ENGINE (HARDWARE ACCELERATED)
  // =========================================================

  getCachedImage(url, onLoaded) {
    if (!url) return null;
    let img = this.imageCache.get(url);
    if (!img) {
      img = new Image();
      img.src = url;
      img.onload = () => {
        if (typeof onLoaded === 'function') onLoaded();
      };
      this.imageCache.set(url, img);
    } else if (!img.complete && typeof onLoaded === 'function') {
      const prevOnload = img.onload;
      img.onload = () => {
        if (typeof prevOnload === 'function') prevOnload();
        onLoaded();
      };
    }
    return img;
  }

  scheduleFilmstripRedraw() {
    if (this._filmstripRafId) return;
    this._filmstripRafId = requestAnimationFrame(() => {
      this._filmstripRafId = null;
      this.drawAllFilmstrips();
    });
  }

  drawAllFilmstrips() {
    if (!this.clipsSequencer || this.segments.length === 0) return;
    const totalTrackWidth = this.getTrackWidth();
    for (const seg of this.segments) {
      const canvas = document.getElementById(`filmstrip_${seg.id}`);
      if (canvas) {
        const clipDuration = Math.max(0.1, seg.end - seg.start);
        this.drawClipFilmstrip(canvas, seg, clipDuration, totalTrackWidth);
      }
    }
  }

  drawClipFilmstrip(canvas, seg, clipDuration, totalTrackWidth) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const trackWidth = totalTrackWidth || this.getTrackWidth();
    const cssWidth = Math.max(40, (clipDuration / Math.max(0.001, this.totalDuration)) * trackWidth);
    const cssHeight = 60;

    const targetW = Math.round(cssWidth * dpr);
    const targetH = Math.round(cssHeight * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.scale(dpr, dpr);

    // 1. Dark Filmstrip Base
    ctx.fillStyle = '#111118';
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    const clipThumbs = (seg.thumbnails && seg.thumbnails.length > 0) ? seg.thumbnails : this.thumbnails;
    const clipSrcDur = seg.sourceDuration || this.sourceDuration || 1;

    // Standard 16:9 frame width (~84px cells)
    const cellWidth = 84;
    const frameCount = Math.max(1, Math.ceil(cssWidth / cellWidth));
    const actualCellW = cssWidth / frameCount;

    if (clipThumbs && clipThumbs.length > 0) {
      const totalThumbs = clipThumbs.length;
      for (let f = 0; f < frameCount; f++) {
        const frameProgress = (f + 0.5) / frameCount;
        const frameTime = seg.start + (frameProgress * clipDuration);
        const thumbIdx = Math.min(
          totalThumbs - 1,
          Math.max(0, Math.floor((frameTime / clipSrcDur) * totalThumbs))
        );
        const thumbUrl = clipThumbs[thumbIdx];

        const img = this.getCachedImage(thumbUrl, () => {
          this.scheduleFilmstripRedraw();
        });

        const x = f * actualCellW;
        if (img && img.complete && img.naturalWidth > 0) {
          // Calculate Aspect Fill / Cover crop so frame never distorts
          const imgAspect = img.naturalWidth / img.naturalHeight;
          const cellAspect = actualCellW / cssHeight;
          let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;

          if (imgAspect > cellAspect) {
            sw = img.naturalHeight * cellAspect;
            sx = (img.naturalWidth - sw) / 2;
          } else {
            sh = img.naturalWidth / cellAspect;
            sy = (img.naturalHeight - sh) / 2;
          }

          ctx.drawImage(img, sx, sy, sw, sh, x, 0, actualCellW, cssHeight);
        } else {
          // Elegant frame cell gradient
          const cellGrad = ctx.createLinearGradient(x, 0, x + actualCellW, cssHeight);
          cellGrad.addColorStop(0, '#151520');
          cellGrad.addColorStop(1, '#1e1e2c');
          ctx.fillStyle = cellGrad;
          ctx.fillRect(x, 0, actualCellW, cssHeight);
        }

        // Draw crisp recessed filmstrip frame divider
        if (f > 0) {
          ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
          ctx.fillRect(x - 1, 0, 1, cssHeight);
          ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
          ctx.fillRect(x, 0, 1, cssHeight);
        }
      }
    } else {
      // High-grade placeholder filmstrip with cinematic dividers
      for (let f = 0; f < frameCount; f++) {
        const x = f * actualCellW;
        const cellGrad = ctx.createLinearGradient(x, 0, x + actualCellW, cssHeight);
        cellGrad.addColorStop(0, '#141420');
        cellGrad.addColorStop(1, '#1b1b28');
        ctx.fillStyle = cellGrad;
        ctx.fillRect(x, 0, actualCellW, cssHeight);

        if (f > 0) {
          ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
          ctx.fillRect(x - 1, 0, 1, cssHeight);
        }
      }
    }

    // Top and bottom track guideline lines
    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.fillRect(0, 0, cssWidth, 1);
    ctx.fillRect(0, cssHeight - 1, cssWidth, 1);

    ctx.restore();
  }

  extractInHouseThumbnails(seg, count = 36) {
    if (!seg || !seg.sourceUri) return;
    try {
      const offscreenVideo = document.createElement('video');
      offscreenVideo.src = seg.sourceUri;
      offscreenVideo.crossOrigin = 'anonymous';
      offscreenVideo.muted = true;
      offscreenVideo.preload = 'auto';

      const offscreenCanvas = document.createElement('canvas');
      offscreenCanvas.width = 240;
      offscreenCanvas.height = 135;
      const ctx = offscreenCanvas.getContext('2d');

      const duration = seg.sourceDuration || this.sourceDuration || 10;
      const frames = [];
      let idx = 0;

      const captureNext = () => {
        if (idx >= count) {
          if (frames.length > 0 && (!seg.thumbnails || seg.thumbnails.length === 0)) {
            seg.thumbnails = frames;
            if (seg.id === 'clip_0' && (!this.thumbnails || this.thumbnails.length === 0)) {
              this.thumbnails = frames;
            }
            this.drawAllFilmstrips();
          }
          offscreenVideo.src = '';
          offscreenVideo.remove();
          return;
        }

        const targetTime = (idx / (count - 1)) * Math.max(0.1, duration - 0.2);
        idx++;

        const onSeeked = () => {
          offscreenVideo.removeEventListener('seeked', onSeeked);
          try {
            ctx.drawImage(offscreenVideo, 0, 0, 240, 135);
            const dataUrl = offscreenCanvas.toDataURL('image/jpeg', 0.7);
            frames.push(dataUrl);
            this.getCachedImage(dataUrl);
            if (frames.length === 1 || frames.length % 6 === 0) {
              if (!seg.thumbnails || seg.thumbnails.length < frames.length) {
                seg.thumbnails = [...frames];
                this.drawAllFilmstrips();
              }
            }
          } catch (e) {}
          captureNext();
        };

        offscreenVideo.addEventListener('seeked', onSeeked, { once: true });
        offscreenVideo.currentTime = targetTime;
      };

      offscreenVideo.addEventListener('loadedmetadata', () => {
        captureNext();
      }, { once: true });

      offscreenVideo.addEventListener('error', () => {
        offscreenVideo.src = '';
        offscreenVideo.remove();
      }, { once: true });
    } catch (err) {
      console.log('In-house thumbnail engine notice:', err);
    }
  }

  bindHandle(handle, seg, type, clipEl) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation(); // Crucial: prevent timeline scrubbing when dragging trim handle
      this.isTrimming = true;
      this.selectClipEnd(seg.id, type);

      const wasPlaying = !this.player.video.paused;
      if (wasPlaying) {
        this.player.pause();
      }

      const startX = e.clientX;
      const initStart = seg.start;
      const initEnd = seg.end;
      const initClipDuration = seg.end - seg.start;
      const initTotalDuration = this.totalDuration || 1;
      const trackRect = this.clipsSequencer.getBoundingClientRect();
      const trackWidth = Math.max(1, trackRect.width);
      const pxPerSec = trackWidth / initTotalDuration;

      // Find clip index and duration before this clip
      const clipIndex = this.segments.findIndex(s => s.id === seg.id);
      let durationBefore = 0;
      const initialOffsets = [];
      let accInit = 0;
      for (let i = 0; i < this.segments.length; i++) {
        initialOffsets.push(accInit);
        const d = this.segments[i].end - this.segments[i].start;
        if (i < clipIndex) {
          durationBefore += d;
        }
        accInit += d;
      }

      const allClipCards = this.clipsSequencer.querySelectorAll('.timeline-clip-card');
      const draggedCardEl = allClipCards[clipIndex];
      const initLeftPx = (durationBefore / initTotalDuration) * trackWidth;
      const initWidthPx = (initClipDuration / initTotalDuration) * trackWidth;

      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';

      // Show live trim tooltip
      if (this.trimTooltip) {
        this.trimBadgeType.textContent = type === 'start' ? 'TRIM IN' : 'TRIM OUT';
        this.trimBadgeTime.textContent = this.player.formatTimecode(type === 'start' ? initStart : initEnd);
        this.trimBadgeDelta.textContent = '+0.00s';
        this.trimTooltip.style.display = 'flex';

        const initialHandleRect = handle.getBoundingClientRect();
        const initialCenterX = initialHandleRect.left - trackRect.left + (initialHandleRect.width / 2);
        this.trimTooltip.style.left = `${20 + initialCenterX}px`;
      }

      if (this.timelineHoverGuide) {
        this.timelineHoverGuide.style.display = 'none';
      }

      let hasMoved = false;

      const onMove = (ev) => {
        ev.preventDefault();
        const deltaPx = ev.clientX - startX;
        if (Math.abs(deltaPx) > 2) {
          hasMoved = true;
        }

        const deltaSec = deltaPx / pxPerSec;
        let currentVal = type === 'start' ? initStart : initEnd;
        let deltaVal = 0;
        let actualDeltaPx = 0;

        if (type === 'start') {
          // Cannot trim past (seg.end - 0.1) or before 0
          const maxStart = seg.end - 0.1;
          let proposedStart = initStart + deltaSec;

          // Snapping to playhead if enabled
          if (this.snappingEnabled && Math.abs(proposedStart - this.player.video.currentTime) < 0.15) {
            proposedStart = this.player.video.currentTime;
          }

          seg.start = Math.max(0, Math.min(maxStart, proposedStart));
          currentVal = seg.start;
          deltaVal = seg.start - initStart;
          actualDeltaPx = deltaVal * pxPerSec;

          // Update dragged clip position in pixels
          if (draggedCardEl) {
            const newLeft = initLeftPx + actualDeltaPx;
            const newWidth = Math.max(10, initWidthPx - actualDeltaPx);
            draggedCardEl.style.left = `${newLeft}px`;
            draggedCardEl.style.width = `${newWidth}px`;
            const badge = draggedCardEl.querySelector('.clip-duration-text');
            if (badge) badge.textContent = `${(seg.end - seg.start).toFixed(1)}s`;
            const curCanvas = draggedCardEl.querySelector('.clip-filmstrip-canvas');
            if (curCanvas) {
              this.drawClipFilmstrip(curCanvas, seg, seg.end - seg.start, trackWidth);
            }
          }

          // Seek video smoothly
          if (seg.sourceUri && this.player.currentSourceUri !== seg.sourceUri) {
            this.player.switchSource(seg.sourceUri, seg.start, false);
          } else {
            this.player.seek(seg.start, true);
          }
        } else {
          // Cannot trim before (seg.start + 0.1) or past sourceDuration
          const minEnd = seg.start + 0.1;
          let proposedEnd = initEnd + deltaSec;

          // Snapping to playhead if enabled
          if (this.snappingEnabled && Math.abs(proposedEnd - this.player.video.currentTime) < 0.15) {
            proposedEnd = this.player.video.currentTime;
          }

          const maxEnd = seg.sourceDuration || this.sourceDuration || 10;
          seg.end = Math.min(maxEnd, Math.max(minEnd, proposedEnd));
          currentVal = seg.end;
          deltaVal = seg.end - initEnd;
          actualDeltaPx = deltaVal * pxPerSec;

          // Update dragged clip width
          if (draggedCardEl) {
            const newWidth = Math.max(10, initWidthPx + actualDeltaPx);
            draggedCardEl.style.width = `${newWidth}px`;
            const badge = draggedCardEl.querySelector('.clip-duration-text');
            if (badge) badge.textContent = `${(seg.end - seg.start).toFixed(1)}s`;
            const curCanvas = draggedCardEl.querySelector('.clip-filmstrip-canvas');
            if (curCanvas) {
              this.drawClipFilmstrip(curCanvas, seg, seg.end - seg.start, trackWidth);
            }
          }

          // Shift following cards
          for (let c = clipIndex + 1; c < this.segments.length; c++) {
            const nextCard = allClipCards[c];
            if (nextCard) {
              const origLeft = (initialOffsets[c] / initTotalDuration) * trackWidth;
              nextCard.style.left = `${origLeft + actualDeltaPx}px`;
            }
          }

          // Seek video smoothly
          if (seg.sourceUri && this.player.currentSourceUri !== seg.sourceUri) {
            this.player.switchSource(seg.sourceUri, seg.end, false);
          } else {
            this.player.seek(seg.end, true);
          }
        }

        // Calculate updated sequence time for this edit point
        const seqTime = durationBefore + (type === 'start' ? 0 : (seg.end - seg.start));
        this.player.timeCurrent.textContent = this.player.formatTimecode(Math.max(0, seqTime));

        // Position handle needle & tooltip accurately at the dragged edge
        const handleEdgeX = type === 'start'
          ? (20 + initLeftPx + actualDeltaPx)
          : (20 + initLeftPx + initWidthPx + actualDeltaPx);

        this.timelinePlayhead.style.left = `${handleEdgeX}px`;

        if (this.trimTooltip) {
          this.trimBadgeTime.textContent = this.player.formatTimecode(currentVal);
          const sign = deltaVal >= 0 ? '+' : '';
          this.trimBadgeDelta.textContent = `${sign}${deltaVal.toFixed(2)}s`;
          this.trimTooltip.style.left = `${handleEdgeX}px`;
        }
      };

      const onUp = () => {
        this.isTrimming = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';

        if (this.trimTooltip) {
          this.trimTooltip.style.display = 'none';
        }
        if (this.timelineSnapGuide) {
          this.timelineSnapGuide.style.display = 'none';
        }

        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);

        // Recalculate true sequence duration
        this.recalculateSequenceDuration();

        if (hasMoved) {
          this.pushHistory();
        }

        // Full clean render on release
        this.render();

        // Reselect the handle and highlight it cleanly
        this.selectClipEnd(seg.id, type);

        if (wasPlaying) {
          this.player.play();
        }
      };

      window.addEventListener('mousemove', onMove, { passive: false });
      window.addEventListener('mouseup', onUp);
    });
  }

  // =========================================================
  // INTERACTIVE TIMELINE CLIP REORDERING ENGINE
  // =========================================================

  bindClipReorder(clipEl, seg, idx) {
    clipEl.addEventListener('mousedown', (e) => {
      // 1. Never interfere with trim handles
      if (e.target.classList.contains('trim-drag-handle') || e.target.closest('.trim-drag-handle')) {
        return;
      }

      // Only left mouse button
      if (e.button !== 0) return;

      // Stop propagation so startScrub on trackContainer doesn't run
      e.stopPropagation();

      const startX = e.clientX;
      const startY = e.clientY;
      let hasMovedPastThreshold = false;
      let isDragging = false;
      const fromIndex = this.segments.findIndex(s => s.id === seg.id);
      if (fromIndex === -1) return;

      const wasPlaying = !this.player.video.paused;
      let currentTargetIndex = fromIndex;

      const onMouseMove = (ev) => {
        const deltaX = ev.clientX - startX;
        const deltaY = ev.clientY - startY;

        // 6px movement threshold distinguishes a fast click/seek from intentional drag
        if (!hasMovedPastThreshold) {
          if (Math.hypot(deltaX, deltaY) > 6) {
            hasMovedPastThreshold = true;
            isDragging = true;
            this.isReorderingClip = true;

            if (wasPlaying) {
              this.player.pause();
            }

            clipEl.classList.add('is-reordering');
            document.body.style.cursor = 'grabbing';
            document.body.style.userSelect = 'none';

            if (this.timelineHoverGuide) {
              this.timelineHoverGuide.style.display = 'none';
            }
            if (this.timelineDropIndicator) {
              this.timelineDropIndicator.style.display = 'block';
            }
            if (this.reorderFloatingBadge) {
              this.reorderFloatingBadge.style.display = 'flex';
            }
          } else {
            return;
          }
        }

        // Calculate cursor position along the sequence
        const currentTrackRect = this.clipsSequencer.getBoundingClientRect();
        const currentTrackWidth = Math.max(1, currentTrackRect.width);
        const cursorX = Math.max(0, Math.min(currentTrackWidth, ev.clientX - currentTrackRect.left));
        const cursorPct = cursorX / currentTrackWidth;
        const cursorSeqTime = cursorPct * this.totalDuration;

        // Find which clip boundary the cursor is targeting
        let targetIndex = this.segments.length;
        let accDur = 0;
        for (let i = 0; i < this.segments.length; i++) {
          const s = this.segments[i];
          const dur = Math.max(0, s.end - s.start);
          const midTime = accDur + (dur / 2);
          if (cursorSeqTime < midTime) {
            targetIndex = i;
            break;
          }
          accDur += dur;
        }

        currentTargetIndex = targetIndex;

        // Edge auto-scrolling when dragging clip across zoomed timeline
        if (this.zoomLevel > 1.0 && this.timelineScroller) {
          const scrollerRect = this.timelineScroller.getBoundingClientRect();
          if (ev.clientX > scrollerRect.right - 40) {
            this.timelineScroller.scrollLeft += 15;
          } else if (ev.clientX < scrollerRect.left + 40) {
            this.timelineScroller.scrollLeft -= 15;
          }
        }

        // Sequence time at boundary
        let boundarySeqTime = 0;
        for (let k = 0; k < targetIndex; k++) {
          boundarySeqTime += Math.max(0, this.segments[k].end - this.segments[k].start);
        }

        const boundaryPct = this.totalDuration > 0 ? (boundarySeqTime / this.totalDuration) : 0;
        const indicatorPx = 20 + (boundaryPct * currentTrackWidth);

        if (this.timelineDropIndicator) {
          this.timelineDropIndicator.style.left = `${indicatorPx}px`;
        }

        if (this.reorderFloatingBadge) {
          this.reorderFloatingBadge.style.left = `${indicatorPx}px`;
          const numClips = this.segments.length;

          if (targetIndex === fromIndex || targetIndex === fromIndex + 1) {
            if (this.reorderBadgeText) {
              this.reorderBadgeText.textContent = `Keep in position #${fromIndex + 1}`;
            }
          } else if (targetIndex === 0) {
            if (this.reorderBadgeText) {
              this.reorderBadgeText.textContent = `Move to Start (Position 1 of ${numClips})`;
            }
          } else if (targetIndex >= numClips) {
            if (this.reorderBadgeText) {
              this.reorderBadgeText.textContent = `Move to End (Position ${numClips} of ${numClips})`;
            }
          } else {
            const destPos = targetIndex > fromIndex ? targetIndex : targetIndex + 1;
            if (this.reorderBadgeText) {
              this.reorderBadgeText.textContent = `Move to Position ${destPos} of ${numClips}`;
            }
          }
        }
      };

      const cleanupReorder = () => {
        this.isReorderingClip = false;
        clipEl.classList.remove('is-reordering');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';

        if (this.timelineDropIndicator) {
          this.timelineDropIndicator.style.display = 'none';
        }
        if (this.reorderFloatingBadge) {
          this.reorderFloatingBadge.style.display = 'none';
        }
      };

      const onKeyDown = (eKey) => {
        if (eKey.key === 'Escape' && isDragging) {
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
          window.removeEventListener('keydown', onKeyDown);
          cleanupReorder();
          this.render();
          this.showTimelineNotice("Rearrange cancelled [Esc]");
        }
      };

      const onMouseUp = (ev) => {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        window.removeEventListener('keydown', onKeyDown);

        if (isDragging) {
          cleanupReorder();

          if (currentTargetIndex !== fromIndex && currentTargetIndex !== fromIndex + 1) {
            const [movedClip] = this.segments.splice(fromIndex, 1);
            const finalIndex = currentTargetIndex > fromIndex ? currentTargetIndex - 1 : currentTargetIndex;
            this.segments.splice(finalIndex, 0, movedClip);

            this.activeClipId = movedClip.id;
            this.recalculateSequenceDuration();
            this.pushHistory();
            this.render();

            // Seek playhead to start of moved clip at its new sequence time
            let newSeqTime = 0;
            for (let m = 0; m < finalIndex; m++) {
              newSeqTime += (this.segments[m].end - this.segments[m].start);
            }
            this.seekToSequenceTime(newSeqTime, false);
            this.showTimelineNotice(`Moved "${movedClip.name || 'Clip'}" to position #${finalIndex + 1}`);
          }
        } else {
          // Normal click without drag: select clip and seek playhead to clicked point
          this.activeClipId = seg.id;
          this.selectedEditPoint = null;
          this.highlightActive();
          this.seekToScreenPos(ev, false);
        }
      };

      window.addEventListener('mousemove', onMouseMove, { passive: false });
      window.addEventListener('mouseup', onMouseUp);
      window.addEventListener('keydown', onKeyDown);
    });
  }

  moveActiveClip(direction) {
    if (!this.activeClipId || this.segments.length <= 1) return;
    const curIdx = this.segments.findIndex(s => s.id === this.activeClipId);
    if (curIdx === -1) return;
    this.moveClipByIndex(curIdx, direction);
  }

  moveClipByIndex(index, direction) {
    if (index < 0 || index >= this.segments.length) return;
    const targetIdx = index + direction;
    if (targetIdx < 0 || targetIdx >= this.segments.length) {
      this.showTimelineNotice(direction < 0 ? "Clip is already at start of sequence" : "Clip is already at end of sequence");
      return;
    }

    const [movedSeg] = this.segments.splice(index, 1);
    this.segments.splice(targetIdx, 0, movedSeg);
    this.activeClipId = movedSeg.id;
    this.recalculateSequenceDuration();
    this.pushHistory();
    this.render();

    let newSeqTime = 0;
    for (let m = 0; m < targetIdx; m++) {
      newSeqTime += (this.segments[m].end - this.segments[m].start);
    }
    this.seekToSequenceTime(newSeqTime, false);
    this.showTimelineNotice(`Moved "${movedSeg.name || 'Clip'}" to position #${targetIdx + 1} [Alt+${direction < 0 ? '←' : '→'}]`);
  }

  renderSegmentsCards() {
    this.segmentsCardsList.innerHTML = '';

    if (this.segments.length === 0) return;

    const formatCardTc = (sec) => {
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      const f = Math.min(59, Math.floor((sec % 1) * (this.player.fps || 60)));
      const pad = (n) => String(n).padStart(2, '0');
      if (sec >= 3600) {
        const h = Math.floor(sec / 3600);
        return `${pad(h)}:${pad(m % 60)}:${pad(s)}`;
      }
      return `${pad(m)}:${pad(s)}.${pad(f)}`;
    };

    this.segments.forEach((seg, idx) => {
      const card = document.createElement('div');
      card.className = `seg-item-card ${seg.id === this.activeClipId ? 'active' : ''}`;
      card.dataset.id = seg.id;
      card.draggable = true;

      const dur = (seg.end - seg.start).toFixed(1);
      const startTc = formatCardTc(seg.start);
      const endTc = formatCardTc(seg.end);

      card.innerHTML = `
        <button class="seg-move-btn seg-move-left" title="Move Left (Alt+←)" ${idx === 0 ? 'disabled' : ''}>
          <i data-feather="chevron-left"></i>
        </button>
        <span class="seg-number">#${idx + 1}</span>
        <span class="seg-range">${startTc} → ${endTc}</span>
        <span class="seg-length">${dur}s</span>
        <button class="seg-move-btn seg-move-right" title="Move Right (Alt+→)" ${idx === this.segments.length - 1 ? 'disabled' : ''}>
          <i data-feather="chevron-right"></i>
        </button>
        <button class="seg-remove-btn" title="Delete Clip"><i data-feather="x"></i></button>
      `;

      const btnLeft = card.querySelector('.seg-move-left');
      if (btnLeft) {
        btnLeft.addEventListener('click', (e) => {
          e.stopPropagation();
          btnLeft.blur();
          this.moveClipByIndex(idx, -1);
        });
      }

      const btnRight = card.querySelector('.seg-move-right');
      if (btnRight) {
        btnRight.addEventListener('click', (e) => {
          e.stopPropagation();
          btnRight.blur();
          this.moveClipByIndex(idx, 1);
        });
      }

      card.querySelector('.seg-remove-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteClipById(seg.id);
      });

      // HTML5 Drag & Drop Reordering of Clips
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', String(idx));
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        document.querySelectorAll('.seg-item-card').forEach(c => c.classList.remove('drag-over-left', 'drag-over-right'));
      });
      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = card.getBoundingClientRect();
        const midX = rect.left + (rect.width / 2);
        if (e.clientX < midX) {
          card.classList.add('drag-over-left');
          card.classList.remove('drag-over-right');
        } else {
          card.classList.add('drag-over-right');
          card.classList.remove('drag-over-left');
        }
      });
      card.addEventListener('dragleave', () => {
        card.classList.remove('drag-over-left', 'drag-over-right');
      });
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('drag-over-left', 'drag-over-right');
        const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
        const rect = card.getBoundingClientRect();
        const midX = rect.left + (rect.width / 2);
        const toIdx = e.clientX < midX ? idx : idx + 1;
        if (!isNaN(fromIdx) && fromIdx >= 0 && fromIdx < this.segments.length) {
          if (toIdx !== fromIdx && toIdx !== fromIdx + 1) {
            const [movedItem] = this.segments.splice(fromIdx, 1);
            const finalIdx = toIdx > fromIdx ? toIdx - 1 : toIdx;
            this.segments.splice(finalIdx, 0, movedItem);
            this.activeClipId = movedItem.id;
            this.recalculateSequenceDuration();
            this.pushHistory();
            this.render();

            let newSeqTime = 0;
            for (let m = 0; m < finalIdx; m++) {
              newSeqTime += (this.segments[m].end - this.segments[m].start);
            }
            this.seekToSequenceTime(newSeqTime, false);
            this.showTimelineNotice(`Moved "${movedItem.name || 'Clip'}" to position #${finalIdx + 1}`);
          }
        }
      });

      // Clicking a card in the bottom tray jumps to the start of that clip cleanly across files
      card.addEventListener('click', () => {
        this.activeClipId = seg.id;
        this.selectedEditPoint = null;
        this.highlightActive();
        if (seg.sourceUri && this.player.currentSourceUri !== seg.sourceUri) {
          this.player.switchSource(seg.sourceUri, seg.start, false);
        } else {
          this.player.seek(seg.start);
        }
        this.seekToSequenceTime(this.getCurrentSequenceTime(), false);
      });

      this.segmentsCardsList.appendChild(card);
    });

    feather.replace();
  }

  highlightActive() {
    document.querySelectorAll('.timeline-clip-card').forEach(el => {
      el.classList.toggle('active', el.dataset.id === this.activeClipId);
    });
    document.querySelectorAll('.seg-item-card').forEach(el => {
      el.classList.toggle('active', el.dataset.id === this.activeClipId);
    });
    document.querySelectorAll('.trim-drag-handle').forEach(el => {
      const parentClip = el.closest('.timeline-clip-card');
      const isStart = el.classList.contains('left');
      const isSelected = this.selectedEditPoint &&
        parentClip &&
        parentClip.dataset.id === this.selectedEditPoint.clipId &&
        ((isStart && this.selectedEditPoint.type === 'start') || (!isStart && this.selectedEditPoint.type === 'end'));
      el.classList.toggle('selected', !!isSelected);
    });
    if (this.player && typeof this.player.syncActiveClipProperties === 'function') {
      this.player.syncActiveClipProperties();
    }
  }

  updateStats() {
    if (this.totalDuration <= 0 || this.segments.length === 0) {
      this.summaryDurationText.textContent = '00:00:00.00';
      this.summaryClipsCount.textContent = '0 Clips';
      if (this.shortsCapBadge) {
        this.shortsCapBadge.textContent = '✓ Shorts Cap (≤ 60s)';
        this.shortsCapBadge.className = 'shorts-cap-badge';
      }
      return;
    }

    this.summaryDurationText.textContent = this.player.formatTimecode(this.totalDuration);
    this.summaryClipsCount.textContent = `${this.segments.length} Clip${this.segments.length > 1 ? 's' : ''}`;

    if (this.shortsCapBadge) {
      if (this.player && this.player.aspectRatio === '16:9') {
        this.shortsCapBadge.textContent = '16:9 Standard Video';
        this.shortsCapBadge.className = 'shorts-cap-badge landscape';
      } else if (this.totalDuration <= 60.5) {
        this.shortsCapBadge.textContent = '✓ Shorts Cap (≤ 60s)';
        this.shortsCapBadge.className = 'shorts-cap-badge';
      } else {
        const secRound = Math.round(this.totalDuration);
        this.shortsCapBadge.textContent = `⚠️ ${secRound}s (Over 60s Shorts limit)`;
        this.shortsCapBadge.className = 'shorts-cap-badge exceeded';
      }
    }

    if (window.exportManager) {
      window.exportManager.updateStats(this.segments, this.totalDuration);
    }
  }

  getSegments() {
    return this.segments.map(s => ({
      id: s.id,
      sourcePath: s.sourcePath || (this.player.meta ? this.player.meta.filePath : null),
      start: Math.round(s.start * 1000) / 1000,
      end: Math.round(s.end * 1000) / 1000,
      name: s.name,
      muted: !!s.muted,
      zoomScale: s.zoomScale || 1.0,
      cropOffsetX: s.cropOffsetX !== undefined ? s.cropOffsetX : 0.5
    }));
  }
}

window.Timeline = Timeline;
