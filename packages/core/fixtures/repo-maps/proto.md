# proto (stack: schema)

Single source of truth for wire messages. Each consumer project generates its own code from
these files; generated code never lives here.

```
messages/
  envelope.proto     message Envelope { uint32 type = 1; bytes payload = 2; }  // type ids in types.proto
  types.proto        enum MsgType { MSG_UNKNOWN = 0; MSG_MOVE = 1; MSG_CHAT = 2; MSG_INVENTORY = 3; MSG_DAMAGE = 4; }
  common.proto       message Vec2 { float x = 1; float y = 2; }
  movement.proto     message Move { uint64 entity_id = 1; Vec2 pos = 2; }
  chat.proto         message ChatLine { uint64 from = 1; string text = 2; }
  inventory.proto    message ItemStack { uint32 item_id = 1; uint32 count = 2; }
                     message InventoryUpdate { repeated ItemStack slots = 1; }
  combat.proto       message Damage { uint64 target = 1; uint32 amount = 2; }
buf.yaml             lint + breaking-change rules
CHANGELOG.md
```

Commands: `buf lint`, `buf breaking --against main`.
