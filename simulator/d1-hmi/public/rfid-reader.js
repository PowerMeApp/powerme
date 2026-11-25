(() => {
  window.bindRfidReader = (input, clear, message, connector) => {
    let pending = false,
      enabled = false,
      context = null;
    const say = (text, bad = false) => {
      message.textContent = text;
      message.classList.toggle('bad', bad);
    };
    const apply = () => {
      input.disabled = clear.disabled = pending || !enabled;
      input.setAttribute('aria-busy', String(pending));
      if (input.disabled) input.value = '';
    };
    clear.onclick = () => {
      input.value = '';
    };
    input.addEventListener('blur', () => {
      input.value = '';
    });
    input.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (pending || !enabled || event.repeat) {
        input.value = '';
        return;
      }
      const idTag = input.value;
      input.value = '';
      if (
        event.isComposing ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.shiftKey ||
        idTag.length !== 10 ||
        !/^[0-9]{10}$/.test(idTag)
      ) {
        say('Cần đúng 10 chữ số rồi Enter. Bấm lại ô và quẹt lại thẻ.', true);
        return;
      }
      pending = true;
      apply();
      say('Đang chờ CSMS xác thực thẻ. Không quẹt lại.');
      try {
        const response = await fetch('/api/swipeReader', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ connector, idTag }),
        });
        const result = await response.json();
        say(result.message, !result.ok);
      } catch {
        say(
          'Mất kết nối HMI; kết quả chưa xác định. Kiểm tra trạng thái súng/CSMS trước khi thử lại.',
          true,
        );
      } finally {
        pending = false;
        apply();
      }
    });
    apply();
    return (state, gun, connected) => {
      const next = JSON.stringify([
        connected,
        state?.net?.epoch,
        state?.net?.state,
        state?.net?.halfOpen,
        gun?.plugged,
        gun?.status,
        gun?.inoperative,
        gun?.txActive,
        gun?.errorCode,
        gun?.remoteWaitSec,
        gun?.readerPending,
      ]);
      if (next !== context) input.value = '';
      context = next;
      enabled =
        connected &&
        state?.net?.state === 'online' &&
        state.net.booted &&
        !state.net.halfOpen &&
        !state.net.downRemainingSec &&
        gun?.plugged &&
        gun.status === 'Preparing' &&
        gun.errorCode === 'NoError' &&
        !gun.txActive &&
        !gun.inoperative &&
        !gun.readerPending &&
        gun.remoteWaitSec == null;
      apply();
    };
  };
})();
