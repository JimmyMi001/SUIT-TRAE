/* =========================================================================
   Three.js 粒子背景 — 暖金 ↔ 青碧 漂浮粒子 (60-100个)
   仅首页 Hero 使用
   ========================================================================= */
(function () {
  const canvas = document.getElementById('particles-canvas');
  if (!canvas) return;

  // 检测 reduced motion
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  let renderer, scene, camera, points, animId;
  let mouseX = 0, mouseY = 0;
  let targetX = 0, targetY = 0;

  function init() {
    const COLORS = [
      new THREE.Color('#F0A500'), // 暖金
      new THREE.Color('#F5B83A'), // 浅金
      new THREE.Color('#00C6B7'), // 青碧
      new THREE.Color('#4DDDD0'), // 浅青
    ];

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 1000);
    camera.position.z = 60;

    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);

    // 生成粒子 80 个
    const COUNT = 80;
    const positions = new Float32Array(COUNT * 3);
    const colors = new Float32Array(COUNT * 3);
    const sizes = new Float32Array(COUNT);

    for (let i = 0; i < COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 140;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 80;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 60;

      const c = COLORS[Math.floor(Math.random() * COLORS.length)];
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;

      sizes[i] = Math.random() * 2.4 + 0.6;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

    // 自定义着色器：圆形发光粒子
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: renderer.getPixelRatio() },
      },
      vertexShader: `
        attribute vec3 aColor;
        attribute float aSize;
        uniform float uTime;
        uniform float uPixelRatio;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vec3 pos = position;
          // 缓慢漂浮
          pos.y += sin(uTime * 0.4 + position.x * 0.1) * 2.5;
          pos.x += cos(uTime * 0.3 + position.y * 0.1) * 2.0;
          vec4 mv = modelViewMatrix * vec4(pos, 1.0);
          gl_PointSize = aSize * uPixelRatio * (180.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
          vAlpha = smoothstep(80.0, 30.0, -mv.z);
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          if (d > 0.5) discard;
          float glow = smoothstep(0.5, 0.0, d);
          float core = smoothstep(0.25, 0.0, d);
          vec3 col = vColor * (glow * 0.6 + core * 1.4);
          gl_FragColor = vec4(col, glow * vAlpha * 0.85);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    points = new THREE.Points(geometry, material);
    scene.add(points);

    window.addEventListener('resize', onResize);
    window.addEventListener('mousemove', onMouseMove);
  }

  function onResize() {
    if (!renderer) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  function onMouseMove(e) {
    targetX = (e.clientX / window.innerWidth - 0.5) * 0.4;
    targetY = (e.clientY / window.innerHeight - 0.5) * 0.4;
  }

  const clock = new THREE.Clock();
  function animate() {
    animId = requestAnimationFrame(animate);
    const t = clock.getElapsedTime();
    points.material.uniforms.uTime.value = t;

    // 视差跟随鼠标
    mouseX += (targetX - mouseX) * 0.04;
    mouseY += (targetY - mouseY) * 0.04;
    camera.position.x = mouseX * 10;
    camera.position.y = -mouseY * 10;
    camera.lookAt(scene.position);

    points.rotation.y = t * 0.03;
    points.rotation.x = Math.sin(t * 0.05) * 0.05;

    renderer.render(scene, camera);
  }

  // 页面不可见时暂停
  function onVisibility() {
    if (document.hidden) {
      cancelAnimationFrame(animId);
    } else {
      animate();
    }
  }

  // 等待 Three.js 加载
  function start() {
    if (typeof THREE === 'undefined') {
      // 动态注入 Three.js
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/three@0.160.0/build/three.min.js';
      s.onload = () => { init(); animate(); };
      document.head.appendChild(s);
    } else {
      init(); animate();
    }
    document.addEventListener('visibilitychange', onVisibility);
  }

  start();
})();
