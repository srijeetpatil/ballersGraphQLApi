const pool = require("../../config/dbConfig.js");

const getUserWithPhone = (phone) => {
  return new Promise((resolve, reject) => {
    let data = [];
    pool.query(
      `SELECT * FROM players pl WHERE pl.phone = '${phone}'`,
      (error, results) => {
        if (error) {
          return reject(error);
        }
        data = results.rows;

        resolve(data);
      }
    );
  });
};

module.exports = { getUserWithPhone };
