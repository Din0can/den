// Name-seeded color utility — shared between server and client
// djb2 hash → HSL hue. Same name = same color for everyone.

export function nameToColor(name) {
  let hash = 5381;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) + hash + name.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 80%, 60%)`;
}
