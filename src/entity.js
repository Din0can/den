export class Entity {
  constructor(id, x, y, char = '@', color = '#00ff41', name = '', facing = 'south') {
    this.id = id;
    this.x = x;
    this.y = y;
    this.char = char;
    this.color = color;
    this.name = name;
    this.facing = facing;
  }
}
