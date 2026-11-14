(() => {
  'use strict';

  const FALLBACK_ROOMS = [
    { id: 'lobby', name: '大厅', description: '随便聊聊，认识一下', icon: '☕' },
    { id: 'tech', name: '技术角', description: '代码、产品与灵感', icon: '⌨️' },
    { id: 'offtopic', name: '摸鱼区', description: '认真生活，偶尔摸鱼', icon: '🐟' },
    { id: 'music', name: '音乐台', description: '分享正在循环的歌', icon: '🎧' }
  ];
  const DEFAULT_LIMITS = { name: 16, message: 500, history: 100 };
  const EMOJIS = [
    '😀', '😄', '😁', '😆', '🥹', '😊', '🙂', '😉',
    '😍', '🤩', '😘', '😜', '🤪', '🤔', '🤭', '🫢',
    '😮', '😢', '😭', '😤', '😴', '🤗', '🤝', '🙌',
    '👏', '👍', '👎', '👀', '💪', '🙏', '✨', '💫',
    '🔥', '💚', '💛', '❤️', '🎉', '🎈', '☕', '🍜',
    '🍉', '🌻', '🌈', '🌙', '⭐', '🎵', '🎧', '🚀'
  ];
  const STORAGE_KEYS = {
    name: 'echo-chat-name',
    clientId: 'echo-chat-client-id',
    room: 'echo-chat-room'
  };
  const AVATAR_VARIANTS = 8;
  const CONNECTION_LABELS = {
    connecting: '连接中',
    online: '实时在线',
    reconnecting: '重新连接',
    offline: '已断开'
  };

  const state = {
    rooms: FALLBACK_ROOMS,
    limits: DEFAULT_LIMITS,
    roomId: 'lobby',
    identity: { clientId: '', name: '' },
    messages: [],
    messageIds: new Set(),
    eventSource: null,
    joinToken: 0,
    loading: true,
    sending: false,
    lastRenderedDayKey: null
  };

  const elements = {};
  let dialogMode = 'join';
  let toastTimer = null;
  let toastHideTimer = null;
  const mobileSidebarQuery = window.matchMedia('(max-width: 900px)');

  function cacheElements() {
    const ids = {
      sidebar: 'sidebar',
      sidebarClose: 'sidebarClose',
      sidebarBackdrop: 'sidebarBackdrop',
      menuButton: 'menuButton',
      roomList: 'roomList',
      roomCount: 'roomCount',
      onlineCount: 'onlineCount',
      avatarStack: 'avatarStack',
      presenceNames: 'presenceNames',
      profileAvatar: 'profileAvatar',
      profileName: 'profileName',
      editNameButton: 'editNameButton',
      roomIcon: 'roomIcon',
      roomName: 'roomName',
      roomSlug: 'roomSlug',
      roomDescription: 'roomDescription',
      connectionStatus: 'connectionStatus',
      connectionLabel: 'connectionLabel',
      shareButton: 'shareButton',
      messageScroller: 'messageScroller',
      messageList: 'messageList',
      scrollBottomButton: 'scrollBottomButton',
      messageForm: 'messageForm',
      messageInput: 'messageInput',
      sendButton: 'sendButton',
      charCount: 'charCount',
      emojiButton: 'emojiButton',
      emojiPicker: 'emojiPicker',
      nameDialog: 'nameDialog',
      nameForm: 'nameForm',
      nameInput: 'nameInput',
      nameError: 'nameError',
      nameLimit: 'nameLimit',
      dialogClose: 'dialogClose',
      dialogTitle: 'dialogTitle',
      dialogCopy: 'dialogCopy',
      nameSubmitButton: 'nameSubmitButton',
      toast: 'toast',
      messageTemplate: 'messageTemplate',
      dateTemplate: 'dateTemplate',
      emptyTemplate: 'emptyTemplate'
    };

    for (const [key, id] of Object.entries(ids)) {
      elements[key] = document.getElementById(id);
    }
    elements.nameLimit = document.querySelector('.name-limit');
    elements.nameSubmitLabel = elements.nameSubmitButton.querySelector('span');
  }

  function readStorage(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // The chat still works when storage is blocked; the identity lasts for this tab.
    }
  }

  function createClientId() {
    const stored = readStorage(STORAGE_KEYS.clientId);
    if (stored && /^[a-zA-Z0-9_-]{8,64}$/.test(stored)) return stored;

    const generated = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `client_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    writeStorage(STORAGE_KEYS.clientId, generated);
    return generated;
  }

  function normalizeNickname(value) {
    if (typeof value !== 'string') return '';
    const limit = state.limits.name;
    return Array.from(
      value
        .normalize('NFKC')
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
      .slice(0, limit)
      .join('');
  }

  function getRoom(roomId) {
    return state.rooms.find((room) => room.id === roomId) || null;
  }

  function hashString(value) {
    let hash = 0;
    for (const character of String(value)) {
      hash = (hash * 31 + character.codePointAt(0)) >>> 0;
    }
    return hash;
  }

  function avatarClassFor(value) {
    return `avatar--${hashString(value) % AVATAR_VARIANTS}`;
  }

  function initialsFor(name) {
    const characters = Array.from(String(name).trim());
    return characters.length ? characters[0].toUpperCase() : '?';
  }

  function applyAvatar(element, value) {
    for (let index = 0; index < AVATAR_VARIANTS; index += 1) {
      element.classList.remove(`avatar--${index}`);
    }
    element.classList.remove('avatar--waiting');
    element.classList.add(avatarClassFor(value));
  }

  function normalizeConfig(rawConfig) {
    if (!rawConfig || !Array.isArray(rawConfig.rooms)) return null;

    const seenRooms = new Set();
    const rooms = [];
    for (const room of rawConfig.rooms) {
      if (!room || typeof room.id !== 'string' || typeof room.name !== 'string') continue;
      const id = room.id.trim();
      if (!/^[a-z0-9-]{1,32}$/.test(id) || seenRooms.has(id)) continue;
      seenRooms.add(id);
      rooms.push({
        id,
        name: room.name.trim().slice(0, 24) || id,
        description: typeof room.description === 'string' ? room.description.slice(0, 80) : '',
        icon: typeof room.icon === 'string' ? Array.from(room.icon).slice(0, 2).join('') : '💬'
      });
    }

    if (!rooms.length) return null;
    const rawLimits = rawConfig.limits || {};
    const nameLimit = Number.isInteger(rawLimits.name) && rawLimits.name > 0 && rawLimits.name <= 32
      ? rawLimits.name
      : DEFAULT_LIMITS.name;
    const messageLimit = Number.isInteger(rawLimits.message) && rawLimits.message > 0 && rawLimits.message <= 2_000
      ? rawLimits.message
      : DEFAULT_LIMITS.message;

    return {
      rooms,
      limits: { ...DEFAULT_LIMITS, name: nameLimit, message: messageLimit }
    };
  }

  async function loadConfig() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch('/api/config', {
        cache: 'no-store',
        signal: controller.signal
      });
      if (!response.ok) throw new Error('config request failed');
      const config = normalizeConfig(await response.json());
      if (!config) throw new Error('config payload is invalid');
      state.rooms = config.rooms;
      state.limits = config.limits;
    } catch (error) {
      console.warn('Using fallback chat configuration.', error);
      state.rooms = FALLBACK_ROOMS;
      state.limits = DEFAULT_LIMITS;
    } finally {
      clearTimeout(timeout);
    }
  }

  function resolveInitialRoom() {
    const urlRoom = new URL(window.location.href).searchParams.get('room');
    const storedRoom = readStorage(STORAGE_KEYS.room);
    if (getRoom(urlRoom)) return urlRoom;
    if (getRoom(storedRoom)) return storedRoom;
    return state.rooms[0].id;
  }

  function updateRoomUrl(roomId) {
    const url = new URL(window.location.href);
    url.searchParams.set('room', roomId);
    window.history.replaceState(null, '', url);
  }

  function renderRooms() {
    const fragment = document.createDocumentFragment();
    for (const room of state.rooms) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'room-item';
      button.dataset.roomId = room.id;
      button.setAttribute('aria-current', room.id === state.roomId ? 'page' : 'false');

      const icon = document.createElement('span');
      icon.className = 'room-item-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = room.icon;

      const copy = document.createElement('span');
      copy.className = 'room-item-copy';
      const name = document.createElement('span');
      name.className = 'room-item-name';
      name.textContent = room.name;
      const description = document.createElement('span');
      description.className = 'room-item-description';
      description.textContent = room.description;
      copy.append(name, description);
      button.append(icon, copy);

      button.addEventListener('click', () => {
        closeSidebar();
        if (room.id !== state.roomId) {
          if (state.identity.name) {
            enterRoom(room.id);
          } else {
            setActiveRoom(room.id);
            openNameDialog('join');
          }
        }
      });
      fragment.append(button);
    }
    elements.roomList.replaceChildren(fragment);
    elements.roomCount.textContent = String(state.rooms.length).padStart(2, '0');
  }

  function setActiveRoom(roomId) {
    const room = getRoom(roomId);
    if (!room) return;
    state.roomId = roomId;
    writeStorage(STORAGE_KEYS.room, roomId);
    updateRoomUrl(roomId);
    elements.roomName.textContent = room.name;
    elements.roomSlug.textContent = `# ${room.id}`;
    elements.roomDescription.textContent = room.description;
    elements.roomIcon.textContent = room.icon;
    document.title = `#${room.name} · 回声聊天室`;

    for (const button of elements.roomList.querySelectorAll('.room-item')) {
      button.setAttribute('aria-current', button.dataset.roomId === roomId ? 'page' : 'false');
    }
  }

  function renderProfile() {
    const name = state.identity.name;
    elements.profileName.textContent = name || '未设置';
    elements.profileAvatar.textContent = name ? initialsFor(name) : '?';
    applyAvatar(elements.profileAvatar, name || 'visitor');
  }

  function openSidebar() {
    if (!mobileSidebarQuery.matches) return;
    elements.sidebar.inert = false;
    elements.sidebar.classList.add('is-open');
    elements.sidebarBackdrop.classList.add('is-open');
    elements.menuButton.setAttribute('aria-expanded', 'true');
    window.setTimeout(() => elements.sidebarClose.focus(), 100);
  }

  function closeSidebar({ restoreFocus = false } = {}) {
    const wasOpen = elements.sidebar.classList.contains('is-open');
    elements.sidebar.classList.remove('is-open');
    elements.sidebarBackdrop.classList.remove('is-open');
    elements.menuButton.setAttribute('aria-expanded', 'false');
    if (mobileSidebarQuery.matches) elements.sidebar.inert = true;
    if (wasOpen && restoreFocus) elements.menuButton.focus();
  }

  function syncSidebarMode() {
    if (mobileSidebarQuery.matches) {
      const isOpen = elements.sidebar.classList.contains('is-open');
      elements.sidebar.inert = !isOpen;
      elements.menuButton.setAttribute('aria-expanded', String(isOpen));
    } else {
      elements.sidebar.inert = false;
      elements.sidebar.classList.remove('is-open');
      elements.sidebarBackdrop.classList.remove('is-open');
      elements.menuButton.setAttribute('aria-expanded', 'false');
    }
  }

  function openNameDialog(mode = 'join') {
    dialogMode = mode;
    const editing = mode === 'edit';
    elements.dialogTitle.textContent = editing ? '换个称呼' : '给自己起个名字';
    elements.dialogCopy.textContent = editing
      ? '新的昵称会立即出现在当前频道，之前的消息不会改变。'
      : '不用注册，也不用密码。选一个喜欢的小名字，马上开始聊天。';
    elements.nameSubmitLabel.textContent = editing ? '保存昵称' : '进入聊天室';
    elements.dialogClose.hidden = !editing;
    elements.nameInput.value = state.identity.name;
    elements.nameError.hidden = true;
    elements.nameError.textContent = '';

    if (!elements.nameDialog.open) elements.nameDialog.showModal();
    window.setTimeout(() => {
      elements.nameInput.focus();
      elements.nameInput.select();
    }, 30);
  }

  function setConnectionStatus(status) {
    elements.connectionStatus.dataset.state = status;
    elements.connectionLabel.textContent = CONNECTION_LABELS[status] || status;
  }

  function renderPresence({ online = 0, names = [] } = {}) {
    const uniqueNames = [...new Set(
      (Array.isArray(names) ? names : []).filter((name) => typeof name === 'string' && name.trim())
    )];
    const onlineCount = Math.max(0, Number.isFinite(online) ? Math.floor(online) : uniqueNames.length);

    elements.onlineCount.textContent = String(onlineCount);
    elements.presenceNames.textContent = uniqueNames.length
      ? `在线：${uniqueNames.join(' · ')}`
      : '正在等待大家加入…';

    const fragment = document.createDocumentFragment();
    if (!uniqueNames.length) {
      const waiting = document.createElement('span');
      waiting.className = 'avatar avatar--waiting';
      waiting.textContent = '·';
      fragment.append(waiting);
    } else {
      for (const name of uniqueNames.slice(0, 5)) {
        const avatar = document.createElement('span');
        avatar.className = 'avatar';
        applyAvatar(avatar, name);
        avatar.textContent = initialsFor(name);
        fragment.append(avatar);
      }
      const hiddenCount = Math.max(onlineCount, uniqueNames.length) - Math.min(uniqueNames.length, 5);
      if (hiddenCount > 0) {
        const more = document.createElement('span');
        more.className = 'avatar avatar-more';
        more.textContent = `+${hiddenCount}`;
        fragment.append(more);
      }
    }
    elements.avatarStack.replaceChildren(fragment);
  }

  const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short'
  });

  function parseMessageDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function dayKeyFor(date) {
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  }

  function formatDayLabel(date) {
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (dayKeyFor(date) === dayKeyFor(today)) return '今天';
    if (dayKeyFor(date) === dayKeyFor(yesterday)) return '昨天';
    return dateFormatter.format(date);
  }

  function isNearBottom() {
    const distance = elements.messageScroller.scrollHeight
      - elements.messageScroller.scrollTop
      - elements.messageScroller.clientHeight;
    return distance < 96;
  }

  function scrollToBottom(behavior = 'smooth') {
    elements.messageScroller.scrollTo({
      top: elements.messageScroller.scrollHeight,
      behavior
    });
    elements.scrollBottomButton.hidden = true;
  }

  function syncScrollButton({ newMessage = false } = {}) {
    if (isNearBottom()) {
      elements.scrollBottomButton.hidden = true;
      return;
    }
    elements.scrollBottomButton.hidden = false;
    elements.scrollBottomButton.querySelector('span').textContent = newMessage ? '有新消息' : '回到最新';
  }

  function isMessageForRoom(message, roomId = state.roomId) {
    return Boolean(
      message
      && message.room === roomId
      && typeof message.id === 'string'
      && typeof message.clientId === 'string'
      && typeof message.name === 'string'
      && typeof message.text === 'string'
      && typeof message.createdAt === 'string'
      && parseMessageDate(message.createdAt)
    );
  }

  function mergeMessages(incoming) {
    if (!Array.isArray(incoming)) return 0;
    let added = 0;
    for (const message of incoming) {
      if (!isMessageForRoom(message) || state.messageIds.has(message.id)) continue;
      state.messageIds.add(message.id);
      state.messages.push(message);
      added += 1;
    }
    if (added) {
      state.messages.sort((first, second) => (
        parseMessageDate(first.createdAt).getTime() - parseMessageDate(second.createdAt).getTime()
      ));
    }
    return added;
  }

  function appendDateDivider(dayKey, date, parent) {
    if (state.lastRenderedDayKey === dayKey) return;
    const fragment = elements.dateTemplate.content.cloneNode(true);
    const divider = fragment.firstElementChild;
    divider.querySelector('span').textContent = formatDayLabel(date);
    parent.append(fragment);
    state.lastRenderedDayKey = dayKey;
  }

  function createMessageNode(message, { live = false } = {}) {
    const date = parseMessageDate(message.createdAt);
    const fragment = elements.messageTemplate.content.cloneNode(true);
    const node = fragment.firstElementChild;
    const isOwn = message.clientId === state.identity.clientId;

    node.dataset.messageId = message.id;
    node.classList.toggle('message--own', isOwn);
    node.classList.toggle('message--live', live);

    const avatar = node.querySelector('.message-avatar');
    avatar.textContent = initialsFor(message.name);
    applyAvatar(avatar, message.clientId || message.name);

    node.querySelector('.message-name').textContent = isOwn ? `${message.name} · 我` : message.name;
    const time = node.querySelector('.message-time');
    time.dateTime = message.createdAt;
    time.textContent = date ? timeFormatter.format(date) : '';
    node.querySelector('.message-bubble').textContent = message.text;

    return { node, date };
  }

  function appendMessage(message, { live = false } = {}) {
    if (elements.messageList.querySelector('.empty-state, .loading-state')) {
      elements.messageList.replaceChildren();
      state.lastRenderedDayKey = null;
    }

    const { node, date } = createMessageNode(message, { live });
    if (!date) return;
    const fragment = document.createDocumentFragment();
    appendDateDivider(dayKeyFor(date), date, fragment);
    fragment.append(node);
    elements.messageList.append(fragment);
  }

  function showLoadingState() {
    const loading = document.createElement('div');
    loading.className = 'loading-state';
    for (let index = 0; index < 3; index += 1) {
      loading.append(document.createElement('span'));
    }
    elements.messageList.replaceChildren(loading);
  }

  function showEmptyState() {
    const room = getRoom(state.roomId);
    const fragment = elements.emptyTemplate.content.cloneNode(true);
    fragment.querySelector('#emptyTitle').textContent = `欢迎来到「${room.name}」`;
    fragment.querySelector('#emptyCopy').textContent = room.id === 'lobby'
      ? '说声「你好」，成为这个频道里的第一位朋友吧。'
      : '这里还很安静，发一条消息打开话题吧。';
    elements.messageList.replaceChildren(fragment);
  }

  function renderAllMessages({ scrollToEnd = true } = {}) {
    state.lastRenderedDayKey = null;
    elements.scrollBottomButton.hidden = true;

    if (state.loading) {
      showLoadingState();
      return;
    }

    if (!state.messages.length) {
      showEmptyState();
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const message of state.messages) {
      const { node, date } = createMessageNode(message);
      if (!date) continue;
      appendDateDivider(dayKeyFor(date), date, fragment);
      fragment.append(node);
    }
    elements.messageList.replaceChildren(fragment);

    if (scrollToEnd) {
      window.requestAnimationFrame(() => scrollToBottom('auto'));
    }
  }

  function handleStreamedMessage(message) {
    if (!isMessageForRoom(message)) return;
    const added = mergeMessages([message]);
    if (!added || state.loading) return;

    const shouldStick = isNearBottom() || message.clientId === state.identity.clientId;
    appendMessage(message, { live: true });
    if (shouldStick) {
      window.requestAnimationFrame(() => scrollToBottom('smooth'));
    } else {
      syncScrollButton({ newMessage: true });
    }
  }

  function closeEvents() {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
  }

  function parseEventData(event) {
    try {
      return JSON.parse(event.data);
    } catch {
      return null;
    }
  }

  function connectEvents() {
    closeEvents();
    if (!state.identity.name) return;
    if (typeof window.EventSource !== 'function') {
      setConnectionStatus('offline');
      showToast('当前浏览器不支持实时消息，请升级浏览器。', { error: true });
      return;
    }

    const params = new URLSearchParams({
      room: state.roomId,
      name: state.identity.name,
      cid: state.identity.clientId
    });
    const source = new EventSource(`/api/events?${params.toString()}`);
    state.eventSource = source;
    setConnectionStatus('connecting');

    source.onopen = () => {
      if (state.eventSource !== source) return;
      setConnectionStatus('online');
    };

    source.onerror = () => {
      if (state.eventSource !== source) return;
      setConnectionStatus(source.readyState === EventSource.CONNECTING ? 'reconnecting' : 'offline');
    };

    source.addEventListener('ready', (event) => {
      if (state.eventSource !== source) return;
      const data = parseEventData(event);
      if (!data) return;
      setConnectionStatus('online');
      renderPresence(data);
    });

    source.addEventListener('presence', (event) => {
      if (state.eventSource !== source) return;
      const data = parseEventData(event);
      if (data) renderPresence(data);
    });

    source.addEventListener('message', (event) => {
      if (state.eventSource !== source) return;
      const message = parseEventData(event);
      if (message) handleStreamedMessage(message);
    });
  }

  async function enterRoom(roomId) {
    const room = getRoom(roomId);
    if (!room) return;
    if (!state.identity.name) {
      openNameDialog('join');
      return;
    }

    const token = ++state.joinToken;
    closeEvents();
    closeEmojiPicker();
    setActiveRoom(roomId);
    state.messages = [];
    state.messageIds = new Set();
    state.loading = true;
    state.lastRenderedDayKey = null;
    elements.scrollBottomButton.hidden = true;
    elements.messageScroller.scrollTop = 0;
    renderAllMessages();
    renderPresence({ online: 0, names: [] });
    connectEvents();

    try {
      const response = await fetch(`/api/history?room=${encodeURIComponent(roomId)}`, {
        cache: 'no-store'
      });
      if (!response.ok) throw new Error('history request failed');
      const history = await response.json();
      if (token !== state.joinToken || roomId !== state.roomId) return;
      mergeMessages(history.messages);
      state.loading = false;
      renderAllMessages();
    } catch (error) {
      if (token !== state.joinToken || roomId !== state.roomId) return;
      console.warn('Unable to load room history.', error);
      state.loading = false;
      renderAllMessages();
      showToast('历史消息加载失败，请检查网络连接。', { error: true });
    }
  }

  function reconnectEvents() {
    if (!state.identity.name) return;
    connectEvents();
  }

  function countCharacters(value) {
    return Array.from(value).length;
  }

  function resizeMessageInput() {
    if (CSS.supports('field-sizing', 'content')) return;
    const input = elements.messageInput;
    input.style.height = 'auto';
    input.style.height = `${Math.min(120, Math.max(35, input.scrollHeight))}px`;
  }

  function updateComposerState() {
    const count = countCharacters(elements.messageInput.value);
    const limit = state.limits.message;
    elements.charCount.textContent = `${count} / ${limit}`;
    elements.charCount.classList.toggle('is-near-limit', count >= limit * 0.9);
    elements.sendButton.disabled = state.sending
      || count === 0
      || count > limit
      || !state.identity.name;
  }

  function clearMessageInput() {
    elements.messageInput.value = '';
    updateComposerState();
    resizeMessageInput();
  }

  function setSending(sending) {
    state.sending = sending;
    updateComposerState();
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (state.sending || !state.identity.name) return;

    const roomId = state.roomId;
    const originalValue = elements.messageInput.value;
    const text = originalValue.replace(/\r\n?/g, '\n').trim();
    if (!text) return;
    if (countCharacters(text) > state.limits.message) {
      showToast(`消息不能超过 ${state.limits.message} 个字符。`, { error: true });
      return;
    }

    setSending(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);

    try {
      const response = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room: roomId,
          name: state.identity.name,
          clientId: state.identity.clientId,
          text
        }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data && data.error ? data.error : '消息发送失败，请稍后再试');
      }

      const message = data && data.message;
      if (isMessageForRoom(message, roomId) && mergeMessages([message])) {
        if (!state.loading && roomId === state.roomId) {
          appendMessage(message, { live: true });
          window.requestAnimationFrame(() => scrollToBottom('smooth'));
        }
      }

      if (roomId === state.roomId && elements.messageInput.value === originalValue) {
        clearMessageInput();
      }
      closeEmojiPicker();
      if (window.matchMedia('(pointer: fine)').matches) elements.messageInput.focus();
    } catch (error) {
      const message = error.name === 'AbortError'
        ? '发送超时，请检查网络后再试。'
        : error.message;
      showToast(message || '消息发送失败，请稍后再试', { error: true });
    } finally {
      clearTimeout(timeout);
      setSending(false);
    }
  }

  function buildEmojiPicker() {
    const fragment = document.createDocumentFragment();
    for (const emoji of EMOJIS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'emoji-choice';
      button.textContent = emoji;
      button.setAttribute('aria-label', `插入表情 ${emoji}`);
      button.addEventListener('click', () => insertEmoji(emoji));
      fragment.append(button);
    }
    elements.emojiPicker.replaceChildren(fragment);
  }

  function openEmojiPicker() {
    elements.emojiPicker.hidden = false;
    elements.emojiButton.setAttribute('aria-expanded', 'true');
    elements.emojiPicker.scrollTop = 0;
  }

  function closeEmojiPicker() {
    elements.emojiPicker.hidden = true;
    elements.emojiButton.setAttribute('aria-expanded', 'false');
  }

  function toggleEmojiPicker() {
    if (elements.emojiPicker.hidden) {
      openEmojiPicker();
    } else {
      closeEmojiPicker();
    }
  }

  function insertEmoji(emoji) {
    const input = elements.messageInput;
    const currentCount = countCharacters(input.value);
    if (currentCount + countCharacters(emoji) > state.limits.message) {
      showToast(`消息不能超过 ${state.limits.message} 个字符。`, { error: true });
      return;
    }

    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.setRangeText(emoji, start, end, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    closeEmojiPicker();
  }

  function showToast(message, { error = false, duration = 2_600 } = {}) {
    window.clearTimeout(toastTimer);
    window.clearTimeout(toastHideTimer);
    elements.toast.textContent = message;
    elements.toast.classList.toggle('toast--error', error);
    elements.toast.hidden = false;
    window.requestAnimationFrame(() => elements.toast.classList.add('is-visible'));

    toastTimer = window.setTimeout(() => {
      elements.toast.classList.remove('is-visible');
      toastHideTimer = window.setTimeout(() => {
        elements.toast.hidden = true;
      }, 220);
    }, duration);
  }

  async function shareRoom() {
    const url = new URL(window.location.href);
    url.searchParams.set('room', state.roomId);
    url.hash = '';

    try {
      await navigator.clipboard.writeText(url.toString());
      showToast('邀请链接已复制，发给朋友吧。');
    } catch {
      window.prompt('复制下面的邀请链接：', url.toString());
    }
  }

  function handleNameSubmit(event) {
    event.preventDefault();
    const name = normalizeNickname(elements.nameInput.value);
    if (!name) {
      elements.nameError.textContent = '请先填写一个昵称。';
      elements.nameError.hidden = false;
      elements.nameInput.focus();
      return;
    }

    const hadName = Boolean(state.identity.name);
    const nameChanged = state.identity.name !== name;
    state.identity.name = name;
    writeStorage(STORAGE_KEYS.name, name);
    renderProfile();
    elements.nameDialog.close();

    if (!hadName) {
      enterRoom(state.roomId);
      showToast(`欢迎加入，${name}。`);
    } else if (nameChanged) {
      reconnectEvents();
      showToast('昵称已更新。');
    }
  }

  function handleInputKeydown(event) {
    if (
      event.key === 'Enter'
      && !event.shiftKey
      && !event.ctrlKey
      && !event.altKey
      && !event.isComposing
      && event.keyCode !== 229
    ) {
      event.preventDefault();
      if (!elements.sendButton.disabled) elements.messageForm.requestSubmit();
    }
  }

  function bindEvents() {
    elements.menuButton.addEventListener('click', openSidebar);
    elements.sidebarClose.addEventListener('click', () => closeSidebar({ restoreFocus: true }));
    elements.sidebarBackdrop.addEventListener('click', () => closeSidebar({ restoreFocus: true }));
    elements.editNameButton.addEventListener('click', () => {
      closeSidebar();
      openNameDialog('edit');
    });

    elements.nameForm.addEventListener('submit', handleNameSubmit);
    elements.nameInput.addEventListener('input', () => {
      elements.nameError.hidden = true;
    });
    elements.dialogClose.addEventListener('click', () => elements.nameDialog.close());
    elements.nameDialog.addEventListener('cancel', (event) => {
      if (!state.identity.name) event.preventDefault();
    });

    elements.messageForm.addEventListener('submit', sendMessage);
    elements.messageInput.addEventListener('input', () => {
      updateComposerState();
      resizeMessageInput();
    });
    elements.messageInput.addEventListener('keydown', handleInputKeydown);
    elements.scrollBottomButton.addEventListener('click', () => scrollToBottom('smooth'));
    elements.messageScroller.addEventListener('scroll', () => syncScrollButton(), { passive: true });

    elements.emojiButton.addEventListener('click', toggleEmojiPicker);
    elements.shareButton.addEventListener('click', shareRoom);

    document.addEventListener('pointerdown', (event) => {
      if (elements.emojiPicker.hidden) return;
      if (!elements.emojiPicker.contains(event.target) && !elements.emojiButton.contains(event.target)) {
        closeEmojiPicker();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!elements.emojiPicker.hidden) closeEmojiPicker();
      if (elements.sidebar.classList.contains('is-open')) closeSidebar({ restoreFocus: true });
    });

    if (typeof mobileSidebarQuery.addEventListener === 'function') {
      mobileSidebarQuery.addEventListener('change', syncSidebarMode);
    } else {
      mobileSidebarQuery.addListener(syncSidebarMode);
    }

    document.addEventListener('visibilitychange', () => {
      if (
        !document.hidden
        && state.identity.name
        && state.eventSource
        && state.eventSource.readyState === EventSource.CLOSED
      ) {
        reconnectEvents();
      }
    });

    window.addEventListener('pagehide', closeEvents);
  }

  function applyLimitsToUi() {
    elements.messageInput.maxLength = state.limits.message;
    elements.nameInput.maxLength = state.limits.name;
    elements.nameLimit.textContent = `最多 ${state.limits.name} 字`;
    elements.charCount.textContent = `0 / ${state.limits.message}`;
    updateComposerState();
  }

  async function init() {
    cacheElements();
    bindEvents();

    state.identity.clientId = createClientId();
    await loadConfig();
    state.identity.name = normalizeNickname(readStorage(STORAGE_KEYS.name) || '');
    state.roomId = resolveInitialRoom();

    applyLimitsToUi();
    renderRooms();
    setActiveRoom(state.roomId);
    renderProfile();
    buildEmojiPicker();
    syncSidebarMode();
    elements.menuButton.setAttribute('aria-controls', 'sidebar');

    if (state.identity.name) {
      enterRoom(state.roomId);
    } else {
      state.loading = false;
      renderAllMessages();
      setConnectionStatus('offline');
      openNameDialog('join');
    }
  }

  init();
})();
