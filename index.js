const express = require('express');
const app = express();
require('dotenv').config();
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const admin = require('firebase-admin');
const port = process.env.PORT || 3000;

//stripe payment gateway setup
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.gj5u2pw.mongodb.net/?appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const serviceAccount = require('./style-decor-firebase-adminsdk.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

app.use(cors());
app.use(express.json());

const verifyFireBaseToken = async (req, res, next) => {
  console.log(verifyFireBaseToken);
  if (!req.headers.authorization) {
    return res.status(401).send({ message: 'Unauthorized access' });
  }
  const token = req.headers.authorization.split(' ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    next();
  } catch (error) {
    return res.status(401).send({ message: 'Unauthorized access' });
  }
};

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

async function run() {
  try {
    await client.connect();
    const db = client.db('styleDecor');
    const usersCollection = db.collection('users');
    const servicesCollection = db.collection('services');
    const bookingsCollection = db.collection('bookings');

    const verifyDecorator = async (req, res, next) => {
      const { email } = req.query;
      const user = await usersCollection.findOne({ email: email });
      if (user.role === 'decorator') {
        next();
      } else {
        return res.status(401).send({ message: 'Unauthorized access' });
      }
    };
    const verifyAdmin = async (req, res, next) => {
      const { email } = req.query;
      const user = await usersCollection.findOne({ email: email });
      if (user?.role === 'admin') {
        next();
      } else {
        return res.status(401).send({ message: 'Unauthorized access' });
      }
    };

    app.post('/users', async (req, res) => {
      const user = req.body;
      user.role = 'user';
      const query = { email: user.email };
      const existingUser = await usersCollection.findOne(query);
      if (existingUser) {
        return res.send({ message: 'User already exists' });
      }
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.get('/users', verifyAdmin, async (req, res) => {
      const cursor = usersCollection.find();
      const users = await cursor.toArray();
      res.send(users);
    });

    app.get('/user-role', async (req, res) => {
      const { email } = req.query;
      const query = { email: email };
      const projectFields = { role: 1 };
      const result = await usersCollection.findOne(query, {
        projection: { role: 1 },
      });

      res.send(result);
    });

    app.patch('/users/:id', async (req, res) => {
      const id = req.params.id;
      const updatedUser = req.body;
      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          role: updatedUser.role,
          status: 'open',
        },
      };
      const result = await usersCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    app.delete('/users/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await usersCollection.deleteOne(query);
      res.send(result);
    });

    app.post('/service-upload', verifyFireBaseToken, async (req, res) => {
      const service = req.body;
      service.createdAt = new Date();
      const result = await servicesCollection.insertOne(service);
      res.send(result);
    });
    app.get('/services', async (req, res) => {
      const cursor = servicesCollection.find().sort({ createdAt: -1 });
      const services = await cursor.toArray();
      res.send(services);
    });

    app.get('/services/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const service = await servicesCollection.findOne(query);
      res.send(service);
    });

    // stripe payment
    app.post(
      '/create-checkout-session',
      verifyFireBaseToken,
      async (req, res) => {
        const serviceInfo = req.body;

        const session = await stripe.checkout.sessions.create({
          line_items: [
            {
              price_data: {
                currency: 'usd',
                product_data: {
                  name: serviceInfo.serviceTitle,
                },
                unit_amount: serviceInfo.totalPrice * 100,
              },

              quantity: 1,
            },
          ],
          customer_email: serviceInfo.email,
          mode: 'payment',
          metadata: {
            name: serviceInfo.name,
            email: serviceInfo.email,
            location: serviceInfo.location,
            phone: serviceInfo.phone,
            note: serviceInfo.note,
            payment: serviceInfo.payment,
            serviceId: serviceInfo.serviceId,
            serviceTitle: serviceInfo.serviceTitle,
            serviceImage: serviceInfo.serviceImage,
            serviceDate: serviceInfo.eventDate,
            quantity: serviceInfo.quantity,
            totalPrice: serviceInfo.totalPrice,
            paymentStatus: serviceInfo.paymentStatus,
            decorator: null,
          },
          success_url: `${process.env.DOMAIN_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.DOMAIN_URL}/payment-failed`,
        });
        res.send({ url: session.url });
      }
    );

    app.post('/payment-success', verifyFireBaseToken, async (req, res) => {
      const sessionId = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const find = await bookingsCollection.findOne({
        transactionId: session.payment_intent,
      });
      if (find) {
        return;
      }
      if (session) {
        const bookingDetails = session.metadata;
        bookingDetails.createAt = new Date();
        if (session.payment_status === 'paid') {
          bookingDetails.paymentStatus = session.payment_status;
        }
        bookingDetails.transactionId = session.payment_intent;
        const result = await bookingsCollection.insertOne(bookingDetails);
        res.send(result);
      }
    });

    app.get('/bookings', verifyFireBaseToken, verifyAdmin, async (req, res) => {
      const result = await bookingsCollection
        .find()
        .sort({ createAt: -1 })
        .toArray();
      res.send(result);
    });

    app.get('/available-decorator', verifyFireBaseToken, async (req, res) => {
      const query = { role: 'decorator', status: 'open' };
      const result = await usersCollection.find(query).toArray();
      res.send(result);
    });

    app.patch(
      '/bookings-request/:decoratorID',
      verifyFireBaseToken,
      async (req, res) => {
        const { decoratorID } = req.params;
        const bookingId = req.body;
        const query = { _id: new ObjectId(decoratorID) };
        const update = { $set: bookingId };
        const options = {};
        const result = await usersCollection.updateOne(query, update, options);
        if (result.modifiedCount) {
          await bookingsCollection.updateOne(
            { _id: new ObjectId(bookingId.bookingId) },
            {
              $set: { decorator: 'pending' },
            },
            options
          );
        }
        res.send(result);
      }
    );

    app.get(
      '/decorator-services',
      verifyFireBaseToken,
      verifyDecorator,
      async (req, res) => {
        const { email } = req.query;

        const query = [
          {
            $match: { email: email },
          },
          {
            $addFields: {
              bookingObjId: { $toObjectId: '$bookingId' },
            },
          },
          {
            $lookup: {
              from: 'bookings',
              localField: 'bookingObjId',
              foreignField: '_id',
              as: 'bookingInfo',
            },
          },
          {
            $unwind: {
              path: '$bookingInfo',
              preserveNullAndEmptyArrays: true,
            },
          },
        ];
        const result = await usersCollection.aggregate(query).toArray();
        res.send(result);
      }
    );

    app.patch('/booking-status/:id', verifyFireBaseToken, async (req, res) => {
      const { id } = req.params;
      const { bookingStatus, decoratorInfo } = req.body;
      console.log(id);
      console.log(bookingStatus, decoratorInfo);

      const query = { _id: new ObjectId(id) };
      const update = {
        $set: { decorator: decoratorInfo, bookingStatus: bookingStatus },
      };
      const options = {};
      const result = await bookingsCollection.updateOne(query, update, options);
      const userStatus = await usersCollection.updateOne(
        {
          email: decoratorInfo.email,
        },
        { $set: { status: 'busy' } }
      );
      res.send(result);
    });

    app.patch(
      '/booking-status-update/:id',
      verifyFireBaseToken,
      async (req, res) => {
        const { id } = req.params;
        const updateNumber = req.body.update;
        const email = req.body.decoratorEmail;

        if (updateNumber === 2) {
          const query = { _id: new ObjectId(id) };
          const result = await bookingsCollection.updateOne(query, {
            $set: {
              'bookingStatus.1': {
                status: 'Planning Phase',
                time: new Date(),
              },
            },
          });
          res.send(result);
          return;
        }
        if (updateNumber === 3) {
          const query = { _id: new ObjectId(id) };
          const result = await bookingsCollection.updateOne(query, {
            $set: {
              'bookingStatus.2': {
                status: 'Materials Prepared',
                time: new Date(),
              },
            },
          });
          res.send(result);
          return;
        }
        if (updateNumber === 4) {
          const query = { _id: new ObjectId(id) };
          const result = await bookingsCollection.updateOne(query, {
            $set: {
              'bookingStatus.3': {
                status: 'On the Way to Venue',
                time: new Date(),
              },
            },
          });
          res.send(result);
          return;
        }
        if (updateNumber === 5) {
          const query = { _id: new ObjectId(id) };
          const result = await bookingsCollection.updateOne(query, {
            $set: {
              'bookingStatus.4': {
                status: 'Setup in Progress',
                time: new Date(),
              },
            },
          });
          res.send(result);
          return;
        }
        if (updateNumber === 6) {
          const query = { _id: new ObjectId(id) };
          const result = await bookingsCollection.updateOne(query, {
            $set: {
              'bookingStatus.5': {
                status: 'Completed',
                time: new Date(),
              },
            },
          });
          const updateDecoratorStatus = await usersCollection.updateOne(
            { email: email },
            { $set: { status: 'open' } },
            {}
          );
          res.send(result);
          return;
        }
      }
    );

    app.get('/my-bookings', verifyFireBaseToken, async (req, res) => {
      const { email } = req.query;

      const query = { email: email };
      const result = await bookingsCollection.find(query).toArray();
      res.send(result);
    });

    app.get(
      '/complete-service',
      verifyFireBaseToken,
      verifyDecorator,
      async (req, res) => {
        const { email } = req.query;
        const query = {
          'decorator.email': email,
          'bookingStatus.5.status': 'Completed',
        };
        const result = await bookingsCollection.find(query).toArray();
        res.send(result);
      }
    );

    await client.db('admin').command({ ping: 1 });
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!'
    );
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);
