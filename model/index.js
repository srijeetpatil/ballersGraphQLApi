const model = require("./model");
const { getUserWithPhone } = require("./authModel");

module.exports = { getUserWithPhone, ...model };
