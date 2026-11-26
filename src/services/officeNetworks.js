import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
function parseAddress(input) {
  if (typeof input !== 'string' || input.includes('%') || !isIP(input)) fail(`Invalid IP address: ${String(input).slice(0, 80)}`);
  if (isIP(input) === 4) return { bits: 32, value: input.split('.').reduce((n, part) => n * 256n + BigInt(part), 0n) };
  let address = input.toLowerCase();
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':');
    const parts = address.slice(lastColon + 1).split('.').map(Number);
    address = `${address.slice(0, lastColon)}:${(parts[0] * 256 + parts[1]).toString(16)}:${(parts[2] * 256 + parts[3]).toString(16)}`;
  }
  const halves = address.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  const value = groups.reduce((n, group) => n * 65536n + BigInt(`0x${group}`), 0n);
  return { bits: 128, value };
}
function canonical({ bits, value }) {
  if (bits === 32) return [24n, 16n, 8n, 0n].map(shift => Number((value >> shift) & 255n)).join('.');
  const groups = Array.from({ length: 8 }, (_, i) => ((value >> BigInt((7 - i) * 16)) & 65535n).toString(16));
  let start = -1, length = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== '0') { i++; continue; }
    let end = i; while (end < 8 && groups[end] === '0') end++;
    if (end - i > length) { start = i; length = end - i; }
    i = end;
  }
  return length < 2 ? groups.join(':') : `${groups.slice(0, start).join(':')}::${groups.slice(start + length).join(':')}`;
}
export function normalizeNetwork(input) {
  if (typeof input !== 'string') fail('Office IPs must be IP addresses or CIDR ranges.');
  const parts = input.trim().split('/');
  if (parts.length > 2 || parts[0].length > 80) fail('Use an IPv4/IPv6 address or CIDR range.');
  let address = parseAddress(parts[0]);
  let prefix = parts.length === 2 && /^\d+$/.test(parts[1]) ? Number(parts[1]) : parts.length === 1 ? address.bits : NaN;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > address.bits) fail(`Invalid CIDR prefix: ${input}`);
  // Node commonly exposes IPv4 peers as ::ffff:a.b.c.d.
  if (address.bits === 128 && address.value >> 32n === 65535n) {
    if (prefix < 96) fail('Use an IPv4 range for IPv4-mapped addresses.');
    address = { bits: 32, value: address.value & 0xffffffffn }; prefix -= 96;
  }
  const shift = BigInt(address.bits - prefix);
  const network = { bits: address.bits, value: address.value >> shift << shift };
  return { ...network, prefix, text: canonical(network) + (parts.length === 2 ? `/${prefix}` : '') };
}
export function normalizeOfficeIPs(input) {
  const entries = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\s,;]+/).filter(Boolean) : null;
  if (!entries || entries.length > 100) fail('Provide up to 100 office IP addresses or CIDR ranges.');
  return [...new Set(entries.map(value => normalizeNetwork(value).text))];
}
export function matchOfficeIP(peer, entries = []) {
  let address;
  try { address = normalizeNetwork(peer); } catch { return false; }
  return entries.some(entry => {
    try {
      const network = normalizeNetwork(entry);
      return address.bits === network.bits && address.value >> BigInt(address.bits - network.prefix) === network.value >> BigInt(network.bits - network.prefix);
    } catch { return false; }
  });
}
export function peerAddress(req) {
  // Forwarding headers are deliberately not trusted by this direct-server setup.
  try { return normalizeNetwork(req.socket.remoteAddress).text; } catch { return null; }
}
const privateNetworks = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'].map(normalizeNetwork);
const nonPublicIPv4 = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15',
  '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3'
];

export function validateOfficePublicIP(value) {
  if (value === null) return null;
  if (typeof value !== 'string') fail('Enter the dedicated public IPv4 address assigned by your ISP.');
  const ip = value.trim();
  if (!ip) return null;
  if (isIP(ip) !== 4 || matchOfficeIP(ip, nonPublicIPv4)) fail('Enter one dedicated public IPv4 address, without a subnet or private address.');
  return ip;
}

export function officeConnection(req, env = process.env) {
  if (env.RENDER_SERVICE_TYPE !== 'web') return { ip: peerAddress(req), type: 'LAN' };

  // Render public ingress overwrites CF-Connecting-IP. Enable only where ingress is trusted.
  const address = req.headers?.['cf-connecting-ip'];
  if (env.TRUST_RENDER_CLIENT_IP !== 'true' || typeof address !== 'string' || !isIP(address)) return { ip: null, type: 'PUBLIC' };
  const ip = normalizeNetwork(address).text;
  return { ip, type: 'PUBLIC' };
}

export function isPrivateOfficeNetwork(entry) {
  let network;
  try { network = normalizeNetwork(entry); } catch { return false; }
  return privateNetworks.some(range => {
    if (range.bits !== network.bits || network.prefix < range.prefix) return false;
    const shift = BigInt(range.bits - range.prefix);
    return network.value >> shift === range.value >> shift;
  });
}

export function detectOfficeSubnet(req, connection = officeConnection(req), interfaces = networkInterfaces()) {
  if (connection.type !== 'LAN' || !isPrivateOfficeNetwork(connection.ip)) return null;
  try {
    const localIP = normalizeNetwork(req.socket.localAddress).text;
    const iface = Object.values(interfaces).flat().find(entry =>
      !entry.internal && isPrivateOfficeNetwork(entry.cidr) &&
      normalizeNetwork(entry.address).text === localIP && matchOfficeIP(connection.ip, [entry.cidr])
    );
    return iface ? normalizeNetwork(iface.cidr).text : null;
  } catch {
    return null;
  }
}

export function matchesOfficeWifi(req, office, env = process.env) {
  if (!office?.wifi_attendance_enabled) return false;
  const { ip, type } = officeConnection(req, env);
  if (!ip) return false;
  if (type === 'PUBLIC') return ip === office.office_public_ip;
  return isPrivateOfficeNetwork(ip) && matchOfficeIP(ip, (office.office_ips || []).filter(isPrivateOfficeNetwork));
}
function number(value, label, min, max, integer = false) {
  if (value === null || value === undefined || value === '' || (typeof value === 'string' && !value.trim()) || !['string', 'number'].includes(typeof value)) fail(`${label} is required.`);
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < min || numeric > max || (integer && !Number.isInteger(numeric))) fail(`${label} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`);
  return numeric;
}
export function validateOfficeCoordinates(body) {
  return { latitude: number(body.latitude, 'Latitude', -90, 90), longitude: number(body.longitude, 'Longitude', -180, 180) };
}
export function validateOffice(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 150) fail('Office name must contain 1–150 characters.');
  const timezone = typeof body.timezone === 'string' ? body.timezone.trim() : 'Asia/Kolkata';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { fail('Choose a valid timezone, such as Asia/Kolkata.'); }
  if (typeof body.is_primary !== 'boolean') fail('Primary office must be true or false.');
  if (!Array.isArray(body.user_ids) || body.user_ids.length > 10000 || body.user_ids.some(id => !Number.isSafeInteger(id) || id <= 0)) fail('Choose valid users.');
  if (body.address !== undefined && (typeof body.address !== 'string' || body.address.length > 500)) fail('Address must be at most 500 characters.');
  return { name, ...validateOfficeCoordinates(body), radius_m: number(body.radius_m, 'Radius', 1, 100000, true), max_accuracy_m: number(body.max_accuracy_m, 'Maximum GPS accuracy', 1, 10000, true), timezone, office_ips: normalizeOfficeIPs(body.office_ips || []), is_primary: body.is_primary, user_ids: [...new Set(body.user_ids)], address: body.address?.trim() || '' };
}
