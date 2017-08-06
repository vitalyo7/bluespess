'use strict';
var Component = require('./component.js');

const _observers = Symbol('_observers');
const _viewers = Symbol('_viewers');
const _viewing = Symbol('_viewing');
const _key = Symbol('_key');
const _client = Symbol('_client');
const _server_to_net = Symbol('_server_to_net');
const _visible_tiles = Symbol('_visible_tiles');
const _screen_set = Symbol('_screen_set');

const _add_viewing = Symbol('_add_viewing');
const _remove_viewing = Symbol('_remove_viewing');

var id_counter = 0;

class Eye extends Component {
	constructor(atom, template) {
		super(atom, template);
		this[_observers] = [];

		// Key maps. Yes we could just directly use the IDs but then clients would be able to cheat
		this[_server_to_net] = {};

		// The things we can see
		this[_viewing] = {};
		this[_visible_tiles] = new Set();
		this[_screen_set] = new Set();

		// Event handler
		this.atom.on("moved", () => {this.recalculate_visible_tiles()});

		this.recalculate_visible_tiles();

		this.screen = new Proxy({}, {
			set: (target, key, value) => {
				if(value != undefined && !this.atom.server.is_atom(value))
					throw new TypeError(`${value} is not an atom`);
				if(target[key] == value)
					return true;
				if(target[key]) {
					this[_screen_set].delete(target[key]);
					if(!this.can_see(target[key]))
						this[_remove_viewing](target[key]);
				}
				target[key] = value;
				if(target[key]) {
					this[_screen_set].add(target[key]);
					this[_add_viewing](target[key]);
				}
				return true;
			}
		});
	}

	[_add_viewing](item) {
		if(item instanceof Array || item instanceof Set) {
			item.forEach((i) => {
				this[_add_viewing](i);
			})
			return;
		}
		if(!this.atom.server.is_atom(item))
			throw new TypeError(`${item} is not an atom!`);
		if(this[_viewing][this[_server_to_net][item.object_id]])
			return; // We already have this item.
		var netid = "NET_" + (id_counter++);
		if(this[_server_to_net][item.object_id])
			netid = this[_server_to_net][item.object_id];
		else
			this[_server_to_net][item.object_id] = netid;
		this[_viewing][netid] = item;
		item[_viewers].push(this.atom);

		this.enqueue_create_atom(netid, item);
	}

	[_remove_viewing](item) {
		if(item instanceof Array || item instanceof Set) {
			item.forEach((i) => {
				this[_remove_viewing](i);
			});
			return;
		}
		if(!this.atom.server.is_atom(item))
			throw new TypeError(`${item} is not an atom!`);
		var netid = this[_server_to_net][item.object_id];
		if(!netid)
			return // This item is not being tracked, and even if it is there's no way to find out the network id.
		delete this[_viewing][netid];
		delete this[_server_to_net][item.object_id];
		var idx;
		if((idx = item[_viewers].indexOf(this.atom)) != -1)
			item[_viewers].splice(idx, 1);

		this.enqueue_delete_atom(netid);
	}
	enqueue_create_atom(netid, atom) {
		for(var observer of this[_observers]) {
			var client = observer.components.Mob.client;
			if(!client)
				continue;
			client.enqueue_create_atom(netid, atom);
		}
	}
	enqueue_update_atom_var(netid, atom, varname, is_appearance) {
		for(var observer of this[_observers]) {
			var client = observer.components.Mob.client;
			if(!client)
				continue;
			client.enqueue_update_atom_var(netid, atom, varname, is_appearance);
		}
	}
	enqueue_delete_atom(netid) {
		for(var observer of this[_observers]) {
			var client = observer.components.Mob.client;
			if(!client)
				continue;
			client.enqueue_delete_atom(netid);
		}
	}

	recalculate_visible_tiles() {
		var new_visible = this.atom.server.compute_visible_tiles(this.atom, 8);
		var old_visible = this[_visible_tiles];
		var added = [...new_visible].filter((item) => {return !old_visible.has(item);});
		var removed = [...old_visible].filter((item) => {return !new_visible.has(item);});
		this[_visible_tiles] = new_visible;
		for(var tile of added) {
			tile.viewers.push(this.atom);
			for(var item of tile.contents) {
				if(this.can_see(item)) {
					this[_add_viewing](item);
				}
			}
		}
		for(var tile of removed) {
			tile.viewers.splice(tile.viewers.indexOf(this.atom), 1);
			for(var item of tile.contents) {
				if(!this.can_see(item)) {
					this[_remove_viewing](item);
				}
			}
		}
	}
	can_see(item) {
		return this[_visible_tiles].has(item.loc) || this[_screen_set].has(item);
	}
}

class Mob extends Component {
	constructor(atom, template) {
		super(atom, template);

		this[_client] = undefined;
		this[_key] = undefined;

		// Eyes map
		Object.defineProperty(this, 'eyes', {enumerable: true,configurable: false, writable: false, value: new Proxy({}, {
			set: (target, property, value) => {
				property = ""+property;
				if(value instanceof Eye)
					value = value.atom;
				if(value != undefined && !this.atom.server.has_component(value, "Eye"))
					throw new TypeError(`Expected object with Eye component`);
				if(value && value.components.Eye[_observers].indexOf(this) != -1)
					return false;
				var oldEye = target[property];
				if(oldEye && this.client) {
					for(var netid in oldEye.components.Eye[_viewing]) {
						if(!oldEye.components.Eye[_viewing].hasOwnProperty(netid))
							continue;
						this.client.enqueue_delete_atom(netid);
					}
				}
				if(oldEye) {
					var idx = oldEye.components.Eye[_observers].indexOf(this.atom);
					if(idx) {
						oldEye.components.Eye[_observers].splice(idx, 1);
					}
				}
				target[property] = value;
				if(value) {
					value.components.Eye[_observers].push(this.atom);
				}
				if(value && this.client) {
					for(var netid in value.components.Eye[_viewing]) {
						if(!value.components.Eye[_viewing].hasOwnProperty(netid))
							continue;
						var atom = value.components.Eye[_viewing];
						this.client.enqueue_create_atom(netid, atom);
					}
				}
				return true;
			}, defineProperty: () => {throw new Error(`Cannot define property on eyes map`);},
			deleteProperty: (target, property) => {
				this.eyes[property] = undefined;
				delete target[property];
			}
		})});

		this.eyes[""] = this.atom;
	}

	get key() {
		return this[_key];
	}
	set key(val) {
		this.atom.server.dc_mobs[this[_key]] = undefined;
		if(val && val != "") {
			if(this.atom.server.clients[val])
				this.client = this.atom.server.clients[val];
			else
				this.atom.server.dc_mobs[val] = this.atom;
		}
		this[_key] = val;
	}

	get client() {
		return this[_client];
	}
	set client(val) {
		if(!val) {
			this[_key] = null;
			if(this[_client]) {
				this[_client].mob = null;
				this[_client] = null;
			}
			return;
		}
		if(this[_client]) {
			this[_client].mob = null;
		}
		this[_client] = val;
		this[_key] = val.key;
		this[_client].mob = this.atom;
	}
}
Mob.depends = ["Eye"];
Mob.loadBefore = ["Eye"];

module.exports.components = {"Mob": Mob, "Eye": Eye};
// For use by client. This won't end up in the index.js.
module.exports._symbols = {_observers, _client, _viewers, _viewing, _server_to_net, _add_viewing, _remove_viewing};