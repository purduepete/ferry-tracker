// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { App } from '../src/App';
import { cacheBusted, cameraAlt, cameraOrderKey, isOfflinePlaceholder, loadCameraOrder, orderCameras, reorderCameras, saveCameraOrder } from '../src/format';
import { ThemeProvider } from '../src/theme/ThemeProvider';

const cameras = [
  { id: 9041, title: 'WSF Seattle Ferry Holding', description: 'Colman Dock vehicle holding.', imageUrl: 'https://images.wsdot.wa.gov/wsf/colman/colman.jpg', width: 400, height: 421 },
  { id: 9042, title: 'WSF Seattle Ferry Bremerton Holding', description: null, imageUrl: 'https://images.wsdot.wa.gov/wsf/colman/BremertonHolding.jpg', width: 400, height: 246 },
  { id: 9043, title: 'WSF Seattle Ferry Bainbridge Holding', description: null, imageUrl: 'https://images.wsdot.wa.gov/wsf/colman/BainbridgeHolding.jpg', width: 400, height: 246 },
];
const terminals = [
  { id: 7, name: 'Seattle', subjectName: 'seattle', latitude: 47.6, longitude: -122.3, city: 'Seattle', cameras, raw: [] },
  { id: 3, name: 'Bainbridge Island', subjectName: 'bainbridge', latitude: 47.62, longitude: -122.5, city: 'Bainbridge Island', cameras: [], raw: [] },
];

function json(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ data, fetchedAt: '2026-09-01T16:00:00.000Z', source: 'fixture', raw: null })));
}

function mockApi() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('/api/terminals')) return json(terminals);
    if (url.includes('/api/terminal-mates')) return json([{ departingTerminalId: 7, departingTerminalName: 'Seattle', arrivingTerminalId: 3, arrivingTerminalName: 'Bainbridge Island' }]);
    return json([]);
  });
}

describe('terminal cameras', () => {
  it('shows a camera on its terminal card and never sends a referrer', async () => {
    mockApi();
    const user = userEvent.setup();
    render(<ThemeProvider><App /></ThemeProvider>);

    await user.click(await screen.findByRole('tab', { name: 'Terminals' }));
    const image = await screen.findByAltText('WSF Seattle Ferry Holding');
    expect(image).toHaveAttribute('src', 'https://images.wsdot.wa.gov/wsf/colman/colman.jpg');
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(image).toHaveAttribute('loading', 'lazy');
    // Bainbridge has no cameras, so its card shows no strip at all.
    expect(document.querySelectorAll('.camera-strip')).toHaveLength(1);
  });

  it('drops a camera that answers with the WSDOT offline graphic', async () => {
    mockApi();
    const user = userEvent.setup();
    render(<ThemeProvider><App /></ThemeProvider>);

    await user.click(await screen.findByRole('tab', { name: 'Terminals' }));
    const image = await screen.findByAltText('WSF Seattle Ferry Holding');
    // WSDOT serves the placeholder with HTTP 200, so only its intrinsic size gives it away.
    Object.defineProperty(image, 'naturalWidth', { value: 320 });
    Object.defineProperty(image, 'naturalHeight', { value: 250 });
    fireEvent.load(image);

    await waitFor(() => expect(screen.queryByAltText('WSF Seattle Ferry Holding')).not.toBeInTheDocument());
    expect(screen.getByAltText('WSF Seattle Ferry Bremerton Holding')).toBeInTheDocument();
  });

  it('opens an enlarged view that traps focus, closes on Escape, and returns focus', async () => {
    mockApi();
    const user = userEvent.setup();
    render(<ThemeProvider><App /></ThemeProvider>);

    await user.click(await screen.findByRole('tab', { name: 'Terminals' }));
    const thumb = await screen.findByRole('button', { name: /Enlarge WSF Seattle Ferry Holding/ });
    await user.click(thumb);

    const dialog = screen.getByRole('dialog', { name: 'Seattle cameras' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText('Colman Dock vehicle holding.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close camera view' })).toHaveFocus());

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(thumb).toHaveFocus();
  });

  it('steps through every camera at the terminal with arrows and the filmstrip', async () => {
    mockApi();
    const user = userEvent.setup();
    render(<ThemeProvider><App /></ThemeProvider>);

    await user.click(await screen.findByRole('tab', { name: 'Terminals' }));
    await user.click(await screen.findByRole('button', { name: /Enlarge WSF Seattle Ferry Holding/ }));

    const dialog = screen.getByRole('dialog', { name: 'Seattle cameras' });
    expect(within(dialog).getByText('1 of 3')).toBeInTheDocument();

    await user.keyboard('{ArrowRight}');
    expect(within(dialog).getByRole('heading', { name: 'WSF Seattle Ferry Bremerton Holding' })).toBeInTheDocument();
    expect(within(dialog).getByText('2 of 3')).toBeInTheDocument();

    // Wraps rather than stopping at the end.
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(within(dialog).getByText('1 of 3')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('tab', { name: 'WSF Seattle Ferry Bremerton Holding' }));
    expect(within(dialog).getByText('2 of 3')).toBeInTheDocument();
  });

  it('reorders a camera with the grip keys and keeps the choice on this device', async () => {
    mockApi();
    const user = userEvent.setup();
    const view = render(<ThemeProvider><App /></ThemeProvider>);

    await user.click(await screen.findByRole('tab', { name: 'Terminals' }));
    await screen.findByAltText('WSF Seattle Ferry Holding');
    const stripOrder = () => [...document.querySelectorAll('.camera-strip .camera-cell')].map((cell) => (cell as HTMLElement).dataset.cameraId);
    expect(stripOrder()).toEqual(['9041', '9042', '9043']);

    const grip = screen.getByRole('button', { name: 'Reorder WSF Seattle Ferry Holding' });
    grip.focus();
    await user.keyboard('{ArrowRight}');

    expect(stripOrder()).toEqual(['9042', '9041', '9043']);
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Moved WSF Seattle Ferry Holding to position 2 of 3');
    expect(JSON.parse(localStorage.getItem('ferry-tracker-camera-order') ?? '{}')).toEqual({ 7: [9042, 9041, 9043] });

    // The dialog pages in the chosen order, not the order the server sent.
    await user.click(screen.getByRole('button', { name: 'Enlarge WSF Seattle Ferry Bremerton Holding' }));
    expect(within(screen.getByRole('dialog')).getByText('1 of 3')).toBeInTheDocument();

    view.unmount();
    render(<ThemeProvider><App /></ThemeProvider>);
    await user.click(await screen.findByRole('tab', { name: 'Terminals' }));
    await screen.findByAltText('WSF Seattle Ferry Holding');
    expect(stripOrder()).toEqual(['9042', '9041', '9043']);
  });

  it('leaves an offline camera in its stored slot while the visible ones move', async () => {
    localStorage.setItem('ferry-tracker-camera-order', JSON.stringify({ 7: [9041, 9042, 9043] }));
    mockApi();
    const user = userEvent.setup();
    render(<ThemeProvider><App /></ThemeProvider>);

    await user.click(await screen.findByRole('tab', { name: 'Terminals' }));
    const middle = await screen.findByAltText('WSF Seattle Ferry Bremerton Holding');
    Object.defineProperty(middle, 'naturalWidth', { value: 320 });
    Object.defineProperty(middle, 'naturalHeight', { value: 250 });
    fireEvent.load(middle);
    await waitFor(() => expect(screen.queryByAltText('WSF Seattle Ferry Bremerton Holding')).not.toBeInTheDocument());

    screen.getByRole('button', { name: 'Reorder WSF Seattle Ferry Holding' }).focus();
    await user.keyboard('{ArrowRight}');

    // The hidden camera keeps slot 2, so it comes back where it was left.
    expect(JSON.parse(localStorage.getItem('ferry-tracker-camera-order') ?? '{}')).toEqual({ 7: [9043, 9042, 9041] });
  });
});

describe('camera order storage', () => {
  it('applies a stored order and appends a camera WSDOT added later', () => {
    const list = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(orderCameras(list, [3, 1]).map((camera) => camera.id)).toEqual([3, 1, 2]);
    expect(orderCameras(list, undefined).map((camera) => camera.id)).toEqual([1, 2, 3]);
    expect(orderCameras(list, [9, 2]).map((camera) => camera.id)).toEqual([2, 1, 3]);
  });

  it('rewrites only the visible slots when reordering', () => {
    expect(reorderCameras([1, 2, 3], [1, 2, 3], 1, 3)).toEqual([2, 3, 1]);
    // 2 is offline, so it holds slot 2 while 1 and 3 swap around it.
    expect(reorderCameras([1, 2, 3], [1, 3], 1, 3)).toEqual([3, 2, 1]);
    expect(reorderCameras([1, 2, 3], [1, 3], 1, 1)).toEqual([1, 2, 3]);
    expect(reorderCameras([1, 2, 3], [1, 3], 4, 3)).toEqual([1, 2, 3]);
  });

  it('discards junk rather than trusting whatever is in storage', () => {
    localStorage.setItem(cameraOrderKey, '{"7":[3,1,3,"x"],"9":"nope","11":[]}');
    expect(loadCameraOrder()).toEqual({ 7: [3, 1] });

    localStorage.setItem(cameraOrderKey, '[1,2]');
    expect(loadCameraOrder()).toEqual({});

    localStorage.setItem(cameraOrderKey, 'not json');
    expect(loadCameraOrder()).toEqual({});

    localStorage.setItem(cameraOrderKey, JSON.stringify({ 7: Array.from({ length: 200 }, (_, index) => index) }));
    expect(loadCameraOrder()[7]).toHaveLength(64);
  });

  it('round-trips through localStorage', () => {
    saveCameraOrder({ 7: [2, 1] });
    expect(loadCameraOrder()).toEqual({ 7: [2, 1] });
  });
});

describe('camera helpers', () => {
  it('sets the cache-buster as a parameter rather than appending text', () => {
    expect(cacheBusted('https://images.wsdot.wa.gov/wsf/a.jpg', 42)).toBe('https://images.wsdot.wa.gov/wsf/a.jpg?t=42');
    expect(cacheBusted('https://images.wsdot.wa.gov/wsf/a.jpg?size=full', 42)).toBe('https://images.wsdot.wa.gov/wsf/a.jpg?size=full&t=42');
    expect(cacheBusted('https://images.wsdot.wa.gov/wsf/a.jpg?t=1', 42)).toBe('https://images.wsdot.wa.gov/wsf/a.jpg?t=42');
    expect(cacheBusted('not a url', 42)).toBe('not a url');
  });

  it('never leaves the alt text empty', () => {
    expect(cameraAlt({ title: '  ' }, 'Seattle')).toBe('Seattle terminal camera');
    expect(cameraAlt({ title: 'WSF Kingston Terminal' }, 'Kingston')).toBe('WSF Kingston Terminal');
  });

  it('recognises the offline graphic only at its exact size', () => {
    expect(isOfflinePlaceholder(320, 250)).toBe(true);
    // Six live cameras report a size the feed disagrees with, so a mismatch alone means nothing.
    expect(isOfflinePlaceholder(480, 352)).toBe(false);
    expect(isOfflinePlaceholder(400, 245)).toBe(false);
  });
});
