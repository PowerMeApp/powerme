/**
 * Unit test InboundSerializer — hai bản tin tới đồng thời phải được xử lý tuần tự đúng thứ tự.
 */
import { InboundSerializer } from './inbound-serializer.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('InboundSerializer', () => {
  it('hai tác vụ cùng trụ chạy tuần tự: tác vụ 2 chỉ bắt đầu sau khi tác vụ 1 xong', async () => {
    const ser = new InboundSerializer();
    const events: string[] = [];
    const p1 = ser.run('RH24D1-00001', async () => {
      events.push('1 bắt đầu');
      await sleep(30);
      events.push('1 xong');
      return 'a';
    });
    const p2 = ser.run('RH24D1-00001', async () => {
      events.push('2 bắt đầu');
      events.push('2 xong');
      return 'b';
    });
    expect(await Promise.all([p1, p2])).toEqual(['a', 'b']);
    expect(events).toEqual(['1 bắt đầu', '1 xong', '2 bắt đầu', '2 xong']);
  });

  it('thứ tự giữ nguyên với nhiều tác vụ xếp dồn (hàng đợi offline phát lại)', async () => {
    const ser = new InboundSerializer();
    const order: number[] = [];
    const tasks = [5, 1, 3, 2, 4].map((delay, i) =>
      ser.run('cp', async () => {
        await sleep(delay);
        order.push(i);
      }),
    );
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('tác vụ lỗi không chặn tác vụ sau; lỗi trả về đúng người gọi', async () => {
    const ser = new InboundSerializer();
    const p1 = ser.run('cp', async () => {
      throw new Error('handler hỏng');
    });
    const p2 = ser.run('cp', async () => 'vẫn chạy');
    await expect(p1).rejects.toThrow('handler hỏng');
    await expect(p2).resolves.toBe('vẫn chạy');
  });

  it('hai trụ khác nhau không chặn nhau', async () => {
    const ser = new InboundSerializer();
    const events: string[] = [];
    const slow = ser.run('A', async () => {
      await sleep(40);
      events.push('A xong');
    });
    const fast = ser.run('B', async () => {
      events.push('B xong');
    });
    await Promise.all([slow, fast]);
    expect(events).toEqual(['B xong', 'A xong']);
  });

  it('dọn đuôi hàng đợi khi không còn tác vụ', async () => {
    const ser = new InboundSerializer();
    await ser.run('cp', async () => undefined);
    await sleep(0);
    expect(ser.activeKeys).toBe(0);
  });
});
