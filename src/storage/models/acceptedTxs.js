const Sequelize = require('sequelize')

module.exports = [
  'acceptedTxs',
  {
    id: { type: Sequelize.STRING, allowNull: false, primaryKey: true, validate: { isLowercase: true } },
    timestamp: { type: Sequelize.BIGINT, allowNull: false },
    data: { type: Sequelize.TEXT, allowNull: false },
    status: { type: Sequelize.STRING, allowNull: false },
    receipt: { type: Sequelize.STRING, allowNull: false }
  }
]

// these are the values in the documentation. converted them to naming standards
// Tx_id
// Tx_ts
// Tx_data
// Tx_status
// Tx_receipt
