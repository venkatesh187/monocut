/**
 * MonoCut - Application Orchestrator
 * Connects VideoPlayer, Timeline, and ExportManager
 */

document.addEventListener('DOMContentLoaded', () => {
  const player = new VideoPlayer();
  const timeline = new Timeline(player);
  const exportManager = new ExportManager(player, timeline);

  window.player = player;
  window.timeline = timeline;
  window.exportManager = exportManager;

  // Lightweight non-intrusive studio toast notification system
  window.showStudioToast = function(msg, duration = 2200) {
    let toast = document.getElementById('studioToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'studioToast';
      toast.className = 'studio-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('visible');
    if (toast._timer) clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.classList.remove('visible');
    }, duration);
  };

  feather.replace();

  // DOM Elements
  const dragDropOverlay = document.getElementById('dragDropOverlay');
  const emptyWorkspace = document.getElementById('emptyWorkspace');
  const hiddenFileInput = document.getElementById('hiddenFileInput');
  const addClipFileInput = document.getElementById('addClipFileInput');
  const btnSelectFile = document.getElementById('btnSelectFile');
  const btnEnterPath = document.getElementById('btnEnterPath');
  const btnOpenVideo = document.getElementById('btnOpenVideo');
  const btnAddVideosHeader = document.getElementById('btnAddVideosHeader');
  const btnAddClip = document.getElementById('btnAddClip');

  const fileMetaPill = document.getElementById('fileMetaPill');
  const metaFileName = document.getElementById('metaFileName');
  const metaResolution = document.getElementById('metaResolution');
  const metaFps = document.getElementById('metaFps');
  const metaCodec = document.getElementById('metaCodec');

  const pathInputModal = document.getElementById('pathInputModal');
  const filePathField = document.getElementById('filePathField');
  const btnLoadPathSubmit = document.getElementById('btnLoadPathSubmit');
  const btnCancelPathModal = document.getElementById('btnCancelPathModal');
  const btnClosePathModal = document.getElementById('btnClosePathModal');

  const shortcutsModal = document.getElementById('shortcutsModal');
  const btnOpenShortcuts = document.getElementById('btnOpenShortcuts');
  const btnCloseShortcutsModal = document.getElementById('btnCloseShortcutsModal');

  // Check if there is a previously opened video path in localStorage or default to V:\ASTRO's PLAYROOM
  const lastPath = localStorage.getItem('lastVideoPath') || "V:\\ASTRO's PLAYROOM_20260924234706.webm";
  if (lastPath) {
    const emptyButtons = document.querySelector('.empty-buttons');
    if (emptyButtons && !document.getElementById('btnQuickOpenRecent')) {
      const recentBtn = document.createElement('button');
      recentBtn.id = 'btnQuickOpenRecent';
      recentBtn.className = 'btn btn-secondary btn-large';
      const shortName = lastPath.split(/[\\/]/).pop();
      const displayShort = shortName.length > 22 ? shortName.slice(0, 20) + '...' : shortName;
      recentBtn.innerHTML = `<i data-feather="zap"></i><span>Quick Open: ${displayShort}</span>`;
      recentBtn.addEventListener('click', () => loadVideoByDiskPath(lastPath));
      emptyButtons.appendChild(recentBtn);
      feather.replace();
    }
  }

  // Aspect Tabs (16:9 Landscape <-> 9:16 Reel/Shorts)
  document.querySelectorAll('.aspect-tab[data-ratio]').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.aspect-tab[data-ratio]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      player.setAspectRatio(tab.dataset.ratio);
    });
  });

  // Open file dialogs
  btnSelectFile.addEventListener('click', () => hiddenFileInput.click());
  btnOpenVideo.addEventListener('click', () => hiddenFileInput.click());

  if (btnAddVideosHeader) {
    btnAddVideosHeader.addEventListener('click', () => {
      if (addClipFileInput) {
        addClipFileInput.click();
      } else {
        hiddenFileInput.click();
      }
    });
  }

  if (btnAddClip) {
    btnAddClip.addEventListener('click', () => {
      if (addClipFileInput) {
        addClipFileInput.click();
      } else {
        hiddenFileInput.click();
      }
    });
  }

  hiddenFileInput.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    await processSelectedFiles(files);
    hiddenFileInput.value = '';
  });

  if (addClipFileInput) {
    addClipFileInput.addEventListener('change', async (e) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      await processSelectedFiles(files);
      addClipFileInput.value = '';
    });
  }

  // Path Modal
  btnEnterPath.addEventListener('click', () => {
    pathInputModal.style.display = 'flex';
    if (lastPath) filePathField.value = lastPath;
    filePathField.focus();
  });
  btnClosePathModal.addEventListener('click', () => pathInputModal.style.display = 'none');
  btnCancelPathModal.addEventListener('click', () => pathInputModal.style.display = 'none');

  btnLoadPathSubmit.addEventListener('click', async () => {
    const rawPath = filePathField.value.trim().replace(/^["']|["']$/g, '');
    if (!rawPath) return;
    pathInputModal.style.display = 'none';
    await loadVideoByDiskPath(rawPath);
  });

  filePathField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnLoadPathSubmit.click();
  });

  // Shortcuts Modal
  btnOpenShortcuts.addEventListener('click', () => shortcutsModal.style.display = 'flex');
  btnCloseShortcutsModal.addEventListener('click', () => shortcutsModal.style.display = 'none');

  // Full-Window Drag & Drop
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    dragDropOverlay.style.display = 'flex';
  });

  window.addEventListener('dragleave', (e) => {
    if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
      dragDropOverlay.style.display = 'none';
    }
  });

  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDropOverlay.style.display = 'none';
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await processSelectedFiles(e.dataTransfer.files);
    }
  });

  // Automatically blur buttons on click to prevent keyboard Spacebar / Enter conflicts
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button, [role="button"]');
    if (btn) {
      btn.blur();
    }
  });

  // Global Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable) return;
    if (pathInputModal && pathInputModal.style.display === 'flex') return;
    if (shortcutsModal && shortcutsModal.style.display === 'flex' && e.key !== 'Escape') return;

    if (e.code === 'Space' || e.key === ' ' || e.key === 'k' || e.key === 'K') {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return; // Prevent key repeat storms when holding down space
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
      player.togglePlay();
      return;
    } else if (e.key === 's' || e.key === 'S' || e.key === 'c' || e.key === 'C') {
      if (e.repeat) return;
      e.preventDefault();
      timeline.splitAtPlayhead();
    } else if (e.key === '[' || e.key === 'i' || e.key === 'I') {
      if (e.repeat) return;
      e.preventDefault();
      timeline.trimStartToPlayhead();
    } else if (e.key === ']' || (e.key === 'o' && !e.shiftKey) || (e.key === 'O' && !e.shiftKey)) {
      if (e.repeat) return;
      e.preventDefault();
      timeline.trimEndToPlayhead();
    } else if ((e.key === 'o' || e.key === 'O') && e.shiftKey) {
      if (e.repeat) return;
      e.preventDefault();
      player.toggleLoop();
    } else if (e.key === 'p' || e.key === 'P') {
      if (e.repeat) return;
      e.preventDefault();
      player.captureCurrentFrame();
    } else if (e.key === 'n' || e.key === 'N') {
      if (e.repeat) return;
      e.preventDefault();
      timeline.toggleSnapping();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (e.repeat) return;
      e.preventDefault();
      timeline.deleteActiveClip();
    } else if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      timeline.undo();
    } else if ((e.key === 'y' && (e.ctrlKey || e.metaKey)) || (e.key === 'z' && (e.ctrlKey || e.metaKey) && e.shiftKey)) {
      e.preventDefault();
      timeline.redo();
    } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'Left')) {
      e.preventDefault();
      timeline.moveActiveClip(-1);
    } else if (e.altKey && (e.key === 'ArrowRight' || e.key === 'Right')) {
      e.preventDefault();
      timeline.moveActiveClip(1);
    } else if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (typeof timeline.toggleClipSpeedPopover === 'function') {
        timeline.toggleClipSpeedPopover();
      }
    } else if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      timeline.zoomIn();
    } else if ((e.key === '-' || e.key === '_') && !e.ctrlKey) {
      e.preventDefault();
      timeline.zoomOut();
    } else if ((e.key === 'z' || e.key === 'Z') && e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      timeline.zoomFit();
    } else if (e.key === '\\' && !e.shiftKey && !e.ctrlKey) {
      e.preventDefault();
      timeline.zoomFit();
    } else if (e.key === ',' || e.key === '<' || e.key === 'ArrowLeft') {
      e.preventDefault();
      if (timeline.selectedEditPoint) {
        timeline.nudgeSelectedEditPoint(e.shiftKey ? -5 : -1);
      } else if (e.shiftKey || e.key === 'ArrowLeft') {
        player.seekDelta(-1);
      } else {
        player.stepFrame(-1);
      }
    } else if (e.key === '.' || e.key === '>' || e.key === 'ArrowRight') {
      e.preventDefault();
      if (timeline.selectedEditPoint) {
        timeline.nudgeSelectedEditPoint(e.shiftKey ? 5 : 1);
      } else if (e.shiftKey || e.key === 'ArrowRight') {
        player.seekDelta(1);
      } else {
        player.stepFrame(1);
      }
    } else if (e.key === 'Home') {
      e.preventDefault();
      if (timeline && timeline.totalDuration > 0) {
        timeline.seekToSequenceTime(0);
      } else {
        player.seek(0);
      }
    } else if (e.key === 'End') {
      e.preventDefault();
      if (timeline && timeline.totalDuration > 0) {
        timeline.seekToSequenceTime(timeline.totalDuration);
      } else {
        player.seek(player.video.duration || 0);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const segs = timeline.segments || [];
      const curIdx = segs.findIndex(s => s.id === timeline.activeClipId);
      if (curIdx > 0) {
        const prev = segs[curIdx - 1];
        timeline.activeClipId = prev.id;
        timeline.highlightActive();
        if (prev.sourceUri && player.currentSourceUri !== prev.sourceUri) {
          player.switchSource(prev.sourceUri, prev.start, false);
        } else {
          player.seek(prev.start);
        }
        timeline.seekToSequenceTime(timeline.getCurrentSequenceTime(), false);
      } else if (segs.length > 0) {
        const first = segs[0];
        timeline.activeClipId = first.id;
        timeline.highlightActive();
        if (first.sourceUri && player.currentSourceUri !== first.sourceUri) {
          player.switchSource(first.sourceUri, first.start, false);
        } else {
          player.seek(first.start);
        }
        timeline.seekToSequenceTime(0, false);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const segs = timeline.segments || [];
      const curIdx = segs.findIndex(s => s.id === timeline.activeClipId);
      if (curIdx !== -1 && curIdx < segs.length - 1) {
        const next = segs[curIdx + 1];
        timeline.activeClipId = next.id;
        timeline.highlightActive();
        if (next.sourceUri && player.currentSourceUri !== next.sourceUri) {
          player.switchSource(next.sourceUri, next.start, false);
        } else {
          player.seek(next.start);
        }
        timeline.seekToSequenceTime(timeline.getCurrentSequenceTime(), false);
      } else if (curIdx !== -1) {
        const cur = segs[curIdx];
        player.seek(cur.end);
        timeline.seekToSequenceTime(timeline.totalDuration, false);
      }
    } else if (e.key === 'j' || e.key === 'J') {
      e.preventDefault();
      player.seekDelta(-5);
    } else if (e.key === 'l' || e.key === 'L') {
      e.preventDefault();
      player.seekDelta(5);
    } else if (e.key === 'm' || e.key === 'M') {
      if (e.repeat) return;
      player.btnToggleMute.click();
    } else if (e.key === '+' || e.key === '=' || (e.key.toLowerCase() === 'a' && !e.ctrlKey && !e.metaKey && !e.altKey)) {
      if (e.repeat) return;
      e.preventDefault();
      timeline.addNewClip();
    } else if (e.key === '?') {
      btnOpenShortcuts.click();
    }
  });

  /**
   * Process multiple selected or dropped files
   */
  async function processSelectedFiles(files) {
    if (!files || files.length === 0) return;
    const fileList = Array.from(files);

    const isWorkspaceEmpty = !timeline.segments || timeline.segments.length === 0 || emptyWorkspace.style.display !== 'none';
    if (isWorkspaceEmpty) {
      await processSelectedFile(fileList[0]);
      // If user selected multiple files at once, append the rest as clips
      for (let i = 1; i < fileList.length; i++) {
        await loadAdditionalClipFile(fileList[i]);
      }
    } else {
      // Append all selected files as new clips
      for (const file of fileList) {
        await loadAdditionalClipFile(file);
      }
    }
  }

  /**
   * Process initial file to set up main video project
   */
  async function processSelectedFile(file) {
    if (file.path) {
      await loadVideoByDiskPath(file.path);
      return;
    }

    // Call /api/locate-file to resolve actual disk path across V:, C:, etc.
    try {
      const res = await fetch('/api/locate-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, fileSize: file.size })
      });

      const data = await res.json();
      if (data && data.found && data.filePath) {
        setupLoadedVideo(data.filePath, data);
        return;
      }
    } catch (err) {
      console.log('Locate file err:', err);
    }

    // If not located on system drives, stream upload directly to server
    try {
      const formData = new FormData();
      formData.append('video', file);
      const upRes = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });
      if (upRes.ok) {
        const upData = await upRes.json();
        if (upData && upData.filePath) {
          setupLoadedVideo(upData.filePath, upData);
          return;
        }
      }
    } catch (upErr) {
      console.warn('Upload fallback error:', upErr);
    }

    // Fallback if not on disk
    const blobUrl = URL.createObjectURL(file);
    const mockMeta = {
      filePath: file.name,
      fileName: file.name,
      duration: 0,
      width: 3840,
      height: 2160,
      fps: 59.94,
      videoCodec: 'VP9',
      audioCodec: 'Opus'
    };

    player.video.src = blobUrl;
    player.video.onloadedmetadata = () => {
      mockMeta.duration = player.video.duration;
      mockMeta.width = player.video.videoWidth || 3840;
      mockMeta.height = player.video.videoHeight || 2160;
      setupLoadedVideo(blobUrl, mockMeta, false);
    };
  }

  /**
   * Load and append an additional video file as a new clip in the sequence
   */
  async function loadAdditionalClipFile(file) {
    if (!file) return;

    if (file.path) {
      try {
        const res = await fetch('/api/load-path', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: file.path })
        });
        if (res.ok) {
          const meta = await res.json();
          timeline.addVideoClip(meta, true);
          return;
        }
      } catch (err) {
        console.warn('load-path error:', err);
      }
    }

    // Try to locate file on local drives
    try {
      const res = await fetch('/api/locate-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, fileSize: file.size })
      });
      const data = await res.json();
      if (data && data.found && data.filePath) {
        timeline.addVideoClip(data, true);
        return;
      }
    } catch (err) {
      console.log('Locate file err:', err);
    }

    // If not located on system drives, stream upload directly to server
    try {
      const formData = new FormData();
      formData.append('video', file);
      const upRes = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });
      if (upRes.ok) {
        const upData = await upRes.json();
        if (upData && upData.filePath) {
          timeline.addVideoClip(upData, true);
          return;
        }
      }
    } catch (upErr) {
      console.warn('Additional clip upload error:', upErr);
    }

    // Fallback: Read metadata via temporary HTML5 video element using Blob URL
    try {
      const blobUrl = URL.createObjectURL(file);
      const tempVideo = document.createElement('video');
      tempVideo.preload = 'metadata';
      tempVideo.src = blobUrl;

      await new Promise((resolve) => {
        tempVideo.onloadedmetadata = () => resolve();
        tempVideo.onerror = () => resolve();
        setTimeout(resolve, 3000);
      });

      const fallbackMeta = {
        filePath: file.name,
        fileName: file.name,
        sourceUri: blobUrl,
        duration: tempVideo.duration || 10,
        width: tempVideo.videoWidth || 1920,
        height: tempVideo.videoHeight || 1080,
        fps: 60,
        videoCodec: 'H.264',
        audioCodec: 'AAC'
      };

      timeline.addVideoClip(fallbackMeta, true);
    } catch (e) {
      console.error('Failed to load clip:', e);
      alert(`Could not load "${file.name}": ${e.message}`);
    }
  }

  /**
   * Load video by verified disk path
   */
  async function loadVideoByDiskPath(filePath) {
    try {
      const res = await fetch('/api/load-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to inspect file');
      }

      const meta = await res.json();
      setupLoadedVideo(filePath, meta);
    } catch (err) {
      alert(`Error opening file: ${err.message}`);
    }
  }

  /**
   * Set up UI once video is verified
   */
  function setupLoadedVideo(sourceUri, meta, isDiskPath = true) {
    emptyWorkspace.style.display = 'none';

    // 16:9 Landscape is the active default upon video selection
    player.setAspectRatio('16:9');
    document.querySelectorAll('.aspect-tab[data-ratio]').forEach(t => {
      t.classList.toggle('active', t.dataset.ratio === '16:9');
    });

    if (isDiskPath && !sourceUri.startsWith('blob:') && !sourceUri.startsWith('http')) {
      localStorage.setItem('lastVideoPath', sourceUri);
      const streamUrl = `/api/stream?path=${encodeURIComponent(sourceUri)}`;
      player.loadSource(streamUrl, meta);
    } else {
      player.loadSource(sourceUri, meta);
    }

    // Update Header HUD
    metaFileName.textContent = meta.fileName || 'video';
    metaResolution.textContent = `${meta.width}×${meta.height}`;
    metaFps.textContent = `${meta.fps || 60} FPS`;
    metaCodec.textContent = `${meta.videoCodec || 'VP9'} / ${meta.audioCodec || 'Opus'}`;
    fileMetaPill.style.display = 'flex';
    if (btnAddVideosHeader) {
      btnAddVideosHeader.style.display = 'inline-flex';
    }

    // Init timeline & export
    timeline.loadVideo(meta);
    exportManager.setSourceMeta(meta.filePath || sourceUri, meta);
    feather.replace();
  }
});
