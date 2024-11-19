const pool = require("../config/dbConfig.js");

const getDataFromDB = async () => {
  return new Promise((resolve, reject) => {
    let data = [];
    pool.query("select * from users", (error, results) => {
      if (error) {
        return reject(error);
      }
      data = results.rows;

      resolve(data);
    });
  });
};

const createUserModel = async (username, phone, position, password) => {
  return new Promise((resolve, reject) => {
    pool.query(
      `INSERT INTO players (username, phone, position, password)
       VALUES ('${username}', '${phone}', '${position}', '${password}');`,
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

const getPasswordFromUserModel = async (phone) => {
  return new Promise((resolve, reject) => {
    pool.query(
      `SELECT password FROM players where phone = '${phone}'`,
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

module.exports = { getDataFromDB, createUserModel, getPasswordFromUserModel };
