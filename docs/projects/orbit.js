//debugger

//Setting up Canvas - Visualize
/*
var canvas = document.getElementById("canvas");
var ctx = canvas.getContext("2d");

canvas.height = window.innerHeight - 200;
canvas.width = window.innerWidth - 100;
*/          //Converting to SVG.js



//Smaller planets cordinates
x = 2;//3.7 * Math.pow(10, 8);
y = 0.1;

//Variables
G = 1//6.67408 * Math.pow(10, -11);
M = 1//5.9272 * Math.pow(10, 24);         //mass in kg
m = 1//7.35 * Math.pow(10, 22);           //mass in kg

dt = 0.1;

//Smaller x-y speed
Xs = 0;
Ys = 1//4 * Math.pow(10, 2); // 400 m/s

//Forces:
Fx = 0;
Fy = 0;

w = window.innerWidth.toString();
h = window.innerHeight.toString();

var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
svg.setAttribute('id', 'svg-container');
svg.setAttribute('style', 'border: 1px solid black');
svg.setAttribute('width', w);
svg.setAttribute('height', h);
svg.setAttribute('viewBox', '-600 -1000 3000 3000');
svg.setAttributeNS("http://www.w3.org/2000/xmlns/", "xmlns:xlink", "http://www.w3.org/1999/xlink");
document.body.appendChild(svg);

//Sets var VB to an array of the viewBox numbers
var VB = svg.getAttribute('viewBox').split(' ').map(Number);

window.addEventListener('keyup', (key) => {
    if (key.keyCode === 37) {
        VB[0] -= 100;
        svg.setAttribute('viewBox', VB);
    }

    if (key.keyCode === 39) {
        VB[0] += 100;
        svg.setAttribute('viewBox', VB);
    }

    if (key.keyCode === 38) {
        VB[1] -= 100;
        svg.setAttribute('viewBox', VB);
    }

    if (key.keyCode === 40) {
        VB[1] += 100;
        svg.setAttribute('viewBox', VB);
    }

    //Zooming in and out
    if (key.keyCode === 187) {
        VB[2] += 500;
        VB[3] += 500;
        svg.setAttribute('viewBox', VB);
    }

    if (key.keyCode === 189) {
        VB[2] -= 300;
        VB[3] -= 300;
        svg.setAttribute('viewBox', VB);
    }
});


console.log(VB);

//flag for for loop
var One = 0;
var flag = 0;

function oneEuler() {

    for (let i = 0; flag < 1; i++) {

        //useful math var
        x2 = Math.pow(x, 2);          // x to the power of 2
        y2 = Math.pow(y, 2);          // y to the power of 2
        xy2 = x2 / y2;                // used later for acceleration
        yx2 = y2 / x2;                // used later for acceleration
        r = Math.sqrt(Math.pow(x, 2) + Math.pow(y, 2)); //distance between planets

        //console.log(r + "radius is working");

        //Calculate the y-acceleration:
        Fg = Math.pow(G, 2) * Math.pow(M, 2) * Math.pow(m, 2) / (x2 + y2); // Newtons gravitational law - can reuse for ay

        Fy2 = Fg / (xy2 + 1);
        Fy = Math.sqrt(Fy2);
        //Give the force a riktning:
        Fy = Fy * (-y / Math.abs(y));
        ay = Fy / m;

        //Calculate the y-acceleration:
        Fx2 = Fg / (yx2 + 1);
        Fx = Math.sqrt(Fx2);
        //Give the force a riktning
        Fx = Fx * (-x / Math.abs(x));
        ax = Fx / m;

        //Stopping after one orbit
        One = y;

        //
        // ACTUAL EULERS METHOD
        //

        var rect = document.createElementNS("http://www.w3.org/2000/svg", 'rect');
        rect.setAttribute('x', x * 500);
        rect.setAttribute('y', y * 300);
        rect.setAttribute('width', 10);
        rect.setAttribute('height', 10);
        rect.setAttribute('fill', '#95B3D7');
        svg.appendChild(rect);
        document.body.appendChild(svg);


        x = x + Xs * dt;
        y = y + Ys * dt;

        Xs = Xs + ax * dt;
        Ys = Ys + ay * dt;


        console.log("x - pos:" + x);
        console.log("y - pos:" + y);

        // Stop after one orbit
        if (One < 0 && y > 0) flag = 1;
    }

}









function euler() {
    flag = 0;
    for (let i = 0; i < 100; i++) {

        //useful math var
        x2 = Math.pow(x, 2);          // x to the power of 2
        y2 = Math.pow(y, 2);          // y to the power of 2
        xy2 = x2 / y2;                // used later for acceleration
        yx2 = y2 / x2;                // used later for acceleration
        r = Math.sqrt(Math.pow(x, 2) + Math.pow(y, 2)); //distance between planets


        //Calculate the y-acceleration:
        Fg = Math.pow(G, 2) * Math.pow(M, 2) * Math.pow(m, 2) / (x2 + y2); // Newtons gravitational law - can reuse for ay

        Fy2 = Fg / (xy2 + 1);
        Fy = Math.sqrt(Fy2);
        //Give the force a riktning:
        Fy = Fy * (-y / Math.abs(y));
        ay = Fy / m;

        //Calculate the y-acceleration:
        Fx2 = Fg / (yx2 + 1);
        Fx = Math.sqrt(Fx2);
        //Give the force a riktning
        Fx = Fx * (-x / Math.abs(x));
        ax = Fx / m;

        //
        // ACTUAL EULERS METHOD
        //

        var rect = document.createElementNS("http://www.w3.org/2000/svg", 'rect');
        rect.setAttribute('x', x * 500);
        rect.setAttribute('y', y * 300);
        rect.setAttribute('width', 10);
        rect.setAttribute('height', 10);
        rect.setAttribute('fill', '#95B3D7');
        svg.appendChild(rect);
        document.body.appendChild(svg);


        x = x + Xs * dt;
        y = y + Ys * dt;

        Xs = Xs + ax * dt;
        Ys = Ys + ay * dt;


        console.log("x - pos:" + x);
        console.log("y - pos:" + y);

    }

}