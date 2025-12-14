"use strict";

/*
  WICHTIG:
  Blockly läuft im JavaScript Adapter Kontext.
  Wir rufen NICHT direkt meshcore.js auf.
  Stattdessen schicken wir sendTo an deinen Adapter.
*/

function meshcoreSendToAsync(instanceId, command, message) {
  return new Promise((resolve) => {
    // sendTo(instance, command, msg, cb)
    sendTo(instanceId, command, message, (res) => resolve(res));
  });
}

Blockly.Blocks["meshcore_instance"] = {
  init: function () {
    this.appendDummyInput()
      .appendField("Meshcore Instanz")
      .appendField(new Blockly.FieldTextInput("meshcore.0"), "INSTANCE");
    this.setOutput(true, "String");
    this.setColour(210);
  },
};

Blockly.JavaScript["meshcore_instance"] = function (block) {
  const instance = block.getFieldValue("INSTANCE") || "meshcore.0";
  return [`"${instance}"`, Blockly.JavaScript.ORDER_ATOMIC];
};

Blockly.Blocks["meshcore_rpc"] = {
  init: function () {
    this.appendValueInput("INSTANCE")
      .setCheck("String")
      .appendField("Meshcore RPC, Instanz");

    this.appendDummyInput()
      .appendField("Methode")
      .appendField(new Blockly.FieldTextInput("getContacts"), "METHOD");

    this.appendValueInput("ARGS_JSON")
      .setCheck("String")
      .appendField("Args JSON Array");

    this.setOutput(true, "String");
    this.setColour(210);
    this.setTooltip("Ruft eine meshcore.js Methode über den Adapter auf, Ergebnis ist JSON String");
  },
};

Blockly.JavaScript["meshcore_rpc"] = function (block) {
  const instance = Blockly.JavaScript.valueToCode(block, "INSTANCE", Blockly.JavaScript.ORDER_ATOMIC) || '"meshcore.0"';
  const method = (block.getFieldValue("METHOD") || "").replace(/"/g, '\\"');
  const argsJson = Blockly.JavaScript.valueToCode(block, "ARGS_JSON", Blockly.JavaScript.ORDER_ATOMIC) || '"[]"';

  const code =
`(await (async () => {
  let _args = [];
  try {
    const parsed = JSON.parse(${argsJson});
    if (Array.isArray(parsed)) _args = parsed;
  } catch (e) {
    _args = [];
  }

  const _res = await meshcoreSendToAsync(${instance}, "meshcore.rpc", { method: "${method}", args: _args });
  if (!_res || _res.ok !== true) {
    const msg = _res && _res.error ? _res.error : "meshcore.rpc failed";
    throw new Error(msg);
  }
  return JSON.stringify(_res.result ?? null);
})())`;

  return [code, Blockly.JavaScript.ORDER_ATOMIC];
};

Blockly.Blocks["meshcore_connected"] = {
  init: function () {
    this.appendValueInput("INSTANCE")
      .setCheck("String")
      .appendField("Meshcore verbunden, Instanz");

    this.setOutput(true, "Boolean");
    this.setColour(210);
  },
};

Blockly.JavaScript["meshcore_connected"] = function (block) {
  const instance = Blockly.JavaScript.valueToCode(block, "INSTANCE", Blockly.JavaScript.ORDER_ATOMIC) || '"meshcore.0"';
  // JavaScript Adapter Blockly Umgebung: getState(id).val
  const code = `(getState(${instance} + ".info.connection").val === true)`;
  return [code, Blockly.JavaScript.ORDER_ATOMIC];
};

Blockly.Blocks["meshcore_get_contacts_json"] = {
  init: function () {
    this.appendValueInput("INSTANCE")
      .setCheck("String")
      .appendField("Meshcore Kontakte JSON, Instanz");
    this.setOutput(true, "String");
    this.setColour(210);
  },
};

Blockly.JavaScript["meshcore_get_contacts_json"] = function (block) {
  const instance = Blockly.JavaScript.valueToCode(block, "INSTANCE", Blockly.JavaScript.ORDER_ATOMIC) || '"meshcore.0"';
  const code = `(String(getState(${instance} + ".contacts.json").val || "[]"))`;
  return [code, Blockly.JavaScript.ORDER_ATOMIC];
};
