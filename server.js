'use latest';

import { readFileSync } from 'fs';
import bodyParser from 'body-parser';
import express from 'express';
import Webtask from 'webtask-tools';
import { MongoClient } from 'mongodb';
import { ObjectID } from 'mongodb';
import { v4 as uuidgen } from 'uuid';


/// Save version of instanceof (can deal with null, undefined and primitive types)
const isInstance = (x, t) => {
  if (x === null || x === undefined || t === null || t === undefined) {
    return false;
  } else {
    return x instanceof t || x.constructor === t;
  }
};

//// DATA ACCESS ////

let MONGO_URL, MONGO_CA, MONGO_CLIENT_CERT, MONGO_CLIENT_CERT_KEY;

let _con = undefined;
const getConnection = () => {
  if (_con === undefined) {
    _con = MongoClient.connect(MONGO_URL, {
      ssl: true,
      sslCA: MONGO_CA,
      sslKey: MONGO_CLIENT_CERT_KEY,
      sslCert: MONGO_CLIENT_CERT
    });
  }
  return _con;
};


class Secret {
  static _getCollection() {
    return getConnection().then((con) => con.collection('secrets'));
  }

  constructor({_id=uuidgen(), secret, showcount=0, _revId=null, _revNum=0} = {}) {
    this._id = _id;
    this.secret = secret;
    this.showcount = showcount;
    this._revId = _revId;
    this._revNum = _revNum;
  }

  static findOne(_id) {
    return this._getCollection()
      .then((collection) => collection.findOne({_id}))
      .then((doc) => !doc ? doc : this.importData(doc));
  }

  static findNext() {
    return this._getCollection()
      .then((collection) =>
        collection.findOne({}, {
          sort: [['showcount', 1], ['_id', 1]]
      })).then((doc) =>
        !doc ? doc : this.importData(doc));
  }

  reload() {
    return this.constuctor.findOne(this._id);
  }

  /// Import a document from mongodb (could do conversion where necessary)
  static importData({_id, secret, showcount, _revId, _revNum}) {
    return new Secret({_id, secret, showcount, _revId, _revNum});
  }

  /// Export a document to mongod (could do conversion)
  exportData() {
    return {
      _id: this._id,
      secret: this.secret,
      showcount: this.showcount,
      _revId: this._revId,
      _revNum: this._revNum
    };
  }

  validate() {
    // NOTE: Just testing secret for now, because it is externally
    // supplied. For the rest we just trust that the code is correct.
    // NOTE: Would like to use a ValidationError class here that
    // extends Error so we can filter on the type and only expose that
    // via HTTP, but it's impossible to transpile that to es2015
    // (definitely needs runtime support).

    if (!isInstance(this.secret, String))
      throw Error('Secret must be an actual string.');

    if (this.secret.length < 10)
      throw Error('Please share an actual secret.');
  }

  save() {
    this.validate();
    return this.constructor._getCollection().then((collection) => {

      const atomicFilter = {
        _id: this._id,
        _revId: this._revId,
        _revNum: this._revNum
      };

      this._revId = uuidgen();
      this._revNum++;
      const payload = this.exportData();

      if (this._revNum === 1) { // insert
        return collection.insertOne(payload);
      } else { // update
        return collection.findOneAndReplace(atomicFilter, payload);
      }
    });
  }

  /// Atomically update this document.
  /// Applies the function to this document and tries to save it.
  /// If this fails du to race conditions (someone else updated the
  /// document in the meantime), we just fetch the document again
  /// and retry
  updateFn(fn) {
    fn(this);
    return this.save()
      .then((res) => {
        // TODO: Use an abstract saving api (these responses are highly
        // annoying to work with)
        if (res.value || res.insertedCount === 1) // Success
          return this;

        // Atomic failure: Reload & Retry
        const doc = this.reload();
        if (!doc)
          throw Error('Document no longer exists!');
        return doc.then((nu) => nu.updateFn(fn));
      });
  }
}

//// HTTP SERVER ////

/// Make express deal with promises
/// Overwrite the default error handler (we do not want to expose
/// sensitive info from errors)
const asyncExpressHandler = (fn) => (req, res, next) =>
  Promise.resolve(null)
    .then(() => fn(req, res)) // Convert any exceptions to promise errors
    .catch(() => res.status(500).send({'error': 'Internal Server Error'}));

const server = express();
server.use(bodyParser.json());


server.use((req, res, next) => {
  ({MONGO_URL, MONGO_CA, MONGO_CLIENT_CERT,
    MONGO_CLIENT_CERT_KEY} = req.webtaskContext.data);
});

server.post('/exchange-secret', asyncExpressHandler((req, res) => {
  const tostore = new Secret({secret: req.body.secret});

  try {
    tostore.validate()
  } catch (e) {
    return res.status(400).send({error: e.message});
  }

  return Promise.all([
    tostore.save(), Secret.findNext()
  ]).then(([stored, toreturn]) => {

    return !toreturn ? toreturn : toreturn.updateFn((doc) => {
      doc.showcount++
    })
  }).then((toreturn) =>
    res.status(200).send({
      secret: !toreturn ? 'You are the first!' : toreturn.secret
    }));
}));

module.exports = Webtask.fromExpress(server);

server.listen(8000);
