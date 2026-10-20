// Next's test hook keeps font compilation offline in the localhost-only suite.
module.exports = {
  "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap":
    "@font-face { font-family: 'Inter'; src: local('Arial'); }",
  "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600&display=swap":
    "@font-face { font-family: 'Playfair Display'; src: local('Georgia'); }",
};
